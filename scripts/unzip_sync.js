const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '20861184', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '90455d0cdedfe6bb16bd716e2438703b';
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || '';
const SOURCE_CHANNEL = process.env.SOURCE_CHANNEL || '-1002806828665';
const TARGET_CHANNEL = process.env.TARGET_CHANNEL || '-1004316463213';
const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '30', 10);

const AUDIO_EXTS = ['.flac', '.m4a', '.mp3', '.wav', '.opus', '.alac', '.ec3'];

// Local file log
const PROCESSED_LOG = path.join(__dirname, 'processed_zips.json');
function loadProcessed() {
  if (fs.existsSync(PROCESSED_LOG)) {
    try {
      const raw = JSON.parse(fs.readFileSync(PROCESSED_LOG, 'utf8'));
      if (Array.isArray(raw)) {
        return new Set(raw.map(item => String(item).toLowerCase()));
      }
    } catch (_) {}
  }
  return new Set();
}

function saveProcessed(set) {
  try {
    fs.writeFileSync(PROCESSED_LOG, JSON.stringify(Array.from(set)), 'utf8');
  } catch (_) {}
}

function findAudioFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (item.startsWith('__MACOSX') || item.startsWith('.')) continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      findAudioFiles(fullPath, fileList);
    } else {
      const ext = path.extname(item).toLowerCase();
      if (AUDIO_EXTS.includes(ext)) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

(async () => {
  if (!SESSION_STRING) {
    console.error('Error: TELEGRAM_SESSION_STRING is missing!');
    process.exit(1);
  }

  console.log('Connecting to Telegram MTProto...');
  const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  await client.start();
  console.log('Connected successfully!');

  const processed = loadProcessed();
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let sourceEntity;
  try {
    sourceEntity = await client.getEntity(SOURCE_CHANNEL);
  } catch (err) {
    console.error(`Could not resolve source channel: ${err.message}`);
    process.exit(1);
  }

  let targetEntity;
  try {
    targetEntity = await client.getEntity(TARGET_CHANNEL);
  } catch (err) {
    console.error(`Could not resolve target channel: ${err.message}`);
    process.exit(1);
  }

  // =========================================================================
  // TELEGRAM-NATIVE DEDUPLICATION: Read history directly from vault channel
  // Even if Git history is wiped or fresh runner starts, Telegram knows what's there!
  // =========================================================================
  console.log(`Checking vault channel (${TARGET_CHANNEL}) for existing archives & tracks...`);
  const alreadyVaultedArchives = new Set();
  const alreadyVaultedTracks = new Set();

  try {
    const vaultMessages = await client.getMessages(targetEntity, { limit: 500 });
    for (const vm of vaultMessages) {
      // 1. Check for archive log messages (e.g. "Archive Processed: filename.zip")
      if (vm.message) {
        const match = vm.message.match(/Archive Processed:\s*`([^`]+)`/i) || vm.message.match(/Archive Checked:\s*`([^`]+)`/i);
        if (match) {
          alreadyVaultedArchives.add(match[1].trim().toLowerCase());
        }
      }

      // 2. Check for individual audio documents
      if (vm.media && vm.media.document) {
        const audioAttr = vm.media.document.attributes?.find(a => a.className === 'DocumentAttributeAudio');
        if (audioAttr && audioAttr.title) {
          alreadyVaultedTracks.add(audioAttr.title.trim().toLowerCase());
        }
        const fnAttr = vm.media.document.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        if (fnAttr && fnAttr.fileName) {
          alreadyVaultedTracks.add(path.parse(fnAttr.fileName).name.trim().toLowerCase());
          alreadyVaultedTracks.add(fnAttr.fileName.trim().toLowerCase());
        }
      }
    }
  } catch (vErr) {
    console.warn(`Could not read vault history: ${vErr.message}`);
  }

  console.log(`Vault Status: Found ${alreadyVaultedArchives.size} recorded archive(s) and ${alreadyVaultedTracks.size} track(s) already in vault.`);

  console.log(`Scanning last ${SCAN_LIMIT} messages from source channel (${SOURCE_CHANNEL})...`);
  const messages = await client.getMessages(sourceEntity, { limit: SCAN_LIMIT });
  let processedCount = 0;

  for (const msg of messages) {
    if (!msg.media || !msg.media.document) continue;
    const doc = msg.media.document;
    const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const fileName = nameAttr ? nameAttr.fileName : '';

    if (!fileName || !fileName.toLowerCase().endsWith('.zip')) continue;

    const lowerFileName = fileName.toLowerCase();
    const strMsgId = String(msg.id).toLowerCase();
    const strDocId = doc.id ? doc.id.toString().toLowerCase() : '';

    // Check if archive was ALREADY processed either in local log OR in Telegram target channel
    const isAlreadyProcessed =
      alreadyVaultedArchives.has(lowerFileName) ||
      processed.has(strMsgId) ||
      (strDocId && processed.has(strDocId)) ||
      processed.has(lowerFileName);

    if (isAlreadyProcessed) {
      console.log(`[SKIP] Archive "${fileName}" is already in your vault channel. Skipping!`);
      continue;
    }

    console.log(`\n======================================================`);
    console.log(`[NEW ZIP FOUND] ID: ${msg.id} | ${fileName} (${(Number(doc.size) / (1024*1024)).toFixed(1)} MB)`);
    console.log(`Downloading archive...`);

    const zipFilePath = path.join(tmpDir, `zip_${msg.id}.zip`);
    const extractDir = path.join(tmpDir, `extract_${msg.id}`);

    try {
      const buffer = await client.downloadMedia(msg.media, {
        progressCallback: (downloaded, total) => {
          if (total) {
            process.stdout.write(`  Download: ${Math.floor((Number(downloaded) / Number(total)) * 100)}%\r`);
          }
        }
      });

      fs.writeFileSync(zipFilePath, buffer);
      console.log(`\nExtracting archive...`);
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        execSync(`unzip -o -q "${zipFilePath}" -d "${extractDir}"`);
      } catch (unzipErr) {
        console.error(`Unzip command failed: ${unzipErr.message}`);
        continue;
      }

      const audioFiles = findAudioFiles(extractDir);
      console.log(`Found ${audioFiles.length} audio track(s) inside archive.`);

      let uploadedTracks = 0;
      for (let i = 0; i < audioFiles.length; i++) {
        const audioFile = audioFiles[i];
        const baseName = path.basename(audioFile);
        const title = path.parse(baseName).name;
        const cleanTitle = title.trim().toLowerCase();

        // Secondary Track-Level Check: If song is already in vault, skip it!
        if (alreadyVaultedTracks.has(cleanTitle) || alreadyVaultedTracks.has(baseName.toLowerCase())) {
          console.log(`  [SKIP] Track "${baseName}" is already in your vault channel.`);
          continue;
        }

        console.log(`  [${i + 1}/${audioFiles.length}] Uploading: ${baseName}`);

        await client.sendFile(targetEntity, {
          file: audioFile,
          attributes: [
            new Api.DocumentAttributeAudio({
              duration: 0,
              title: title,
              performer: '',
              voice: false,
            })
          ],
          workers: 4,
          progressCallback: (uploaded, total) => {
            if (total) {
              process.stdout.write(`    Upload: ${Math.floor((Number(uploaded) / Number(total)) * 100)}%\r`);
            }
          }
        });
        alreadyVaultedTracks.add(cleanTitle);
        alreadyVaultedTracks.add(baseName.toLowerCase());
        uploadedTracks++;
        console.log('');
      }

      // Record in local cache
      processed.add(strMsgId);
      if (strDocId) processed.add(strDocId);
      processed.add(lowerFileName);
      alreadyVaultedArchives.add(lowerFileName);
      saveProcessed(processed);
      processedCount++;
      console.log(`Completed processing: ${fileName}`);

      // Send log notification to Target Vault Channel (Permanent proof of upload)
      const logText = uploadedTracks > 0
        ? `✅ **Archive Processed:** \`${fileName}\`\n🎵 **Tracks Uploaded:** ${uploadedTracks} file(s)\n📦 **Status:** Unzipped and vaulted successfully!`
        : `ℹ️ **Archive Checked:** \`${fileName}\`\n🎵 **Status:** All tracks already exist in vault. No duplicates uploaded.`;

      try {
        await client.sendMessage(targetEntity, { message: logText });
        console.log(`Sent confirmation log to vault channel.`);
      } catch (tErr) {
        console.warn(`Could not send log to vault channel: ${tErr.message}`);
      }

      // Try sending to source channel if write permissions allow
      try {
        await client.sendMessage(sourceEntity, {
          message: logText,
          replyTo: msg.id
        });
      } catch (_) {}

      // Send alert to personal Saved Messages
      try {
        await client.sendMessage('me', {
          message: `🔔 **Telegram Music Addon Alert**\n${logText}`
        });
      } catch (_) {}

    } catch (err) {
      console.error(`Error processing message ${msg.id}:`, err.message);
    } finally {
      // Clean up disk space
      try {
        if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  console.log(`\nJob finished. Processed ${processedCount} new ZIP archive(s).`);
  await client.disconnect();
  process.exit(0);
})();
