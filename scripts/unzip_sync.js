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
const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '20', 10);

const AUDIO_EXTS = ['.flac', '.m4a', '.mp3', '.wav', '.opus', '.alac', '.ec3'];

// Track already processed messages using a simple file log
const PROCESSED_LOG = path.join(__dirname, 'processed_zips.json');
function loadProcessed() {
  if (fs.existsSync(PROCESSED_LOG)) {
    try {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_LOG, 'utf8')));
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

  console.log(`Scanning last ${SCAN_LIMIT} messages from source channel (${SOURCE_CHANNEL})...`);
  
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

  const messages = await client.getMessages(sourceEntity, { limit: SCAN_LIMIT });
  let processedCount = 0;

  for (const msg of messages) {
    if (!msg.media || !msg.media.document) continue;
    const doc = msg.media.document;
    const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const fileName = nameAttr ? nameAttr.fileName : '';

    if (!fileName || !fileName.toLowerCase().endsWith('.zip')) continue;

    if (processed.has(msg.id)) {
      console.log(`Skipping already processed ZIP [ID: ${msg.id}]: ${fileName}`);
      continue;
    }

    console.log(`\n======================================================`);
    console.log(`[ZIP FOUND] ID: ${msg.id} | ${fileName} (${(Number(doc.size) / (1024*1024)).toFixed(1)} MB)`);
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

      // Unzip using system unzip (standard on Linux/macOS)
      try {
        execSync(`unzip -o -q "${zipFilePath}" -d "${extractDir}"`);
      } catch (unzipErr) {
        console.error(`Unzip command failed: ${unzipErr.message}`);
        continue;
      }

      const audioFiles = findAudioFiles(extractDir);
      console.log(`Found ${audioFiles.length} audio track(s) inside archive.`);

      for (let i = 0; i < audioFiles.length; i++) {
        const audioFile = audioFiles[i];
        const baseName = path.basename(audioFile);
        const title = path.parse(baseName).name;

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
        console.log('');
      }

      processed.add(msg.id);
      saveProcessed(processed);
      processedCount++;
      console.log(`Completed processing: ${fileName}`);

      // Send log notification to source channel
      try {
        const logText = `✅ **Archive Processed:** \`${fileName}\`\n🎵 **Tracks Uploaded:** ${audioFiles.length} file(s)\n📦 **Status:** Unzipped and vaulted successfully!`;
        try {
          // Reply directly to the ZIP file message
          await client.sendMessage(sourceEntity, {
            message: logText,
            replyTo: msg.id
          });
        } catch (_) {
          // Fallback if replies/comments are disabled
          await client.sendMessage(sourceEntity, {
            message: logText
          });
        }
        console.log(`Sent confirmation log to source channel.`);
      } catch (logErr) {
        console.warn(`Could not send log to source channel: ${logErr.message}`);
      }

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
