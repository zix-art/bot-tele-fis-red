import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import nodemailer from 'nodemailer';
import archiver from 'archiver';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';

// Import konfigurasi dari config.js (VERSI BERSIH)
import {
  // 1. Telegram Core
  TELEGRAM_BOT_TOKEN, 
  OWNER_ID, 
  USERNAME_OWNER, 
  
  // 2. Verifikasi Channel/Group
  VERIFICATION_GROUP_USERNAME, 
  VERIFICATION_CHANNEL_USERNAME,
  
  // 3. API Vercel
  API_URL, 
  API_KEY,
  COOLDOWN_DURATION, COOLDOWN_TIME, MAX_RECONNECT_ATTEMPTS, FIX_COOLDOWN,

  // 4. Database Files
  MT_FILE, 
  PREMIUM_FILE, 
  USER_DB, 
  HISTORY_DB, 
  SETTINGS_DB, 
  REFERRAL_DB, 
  GMAIL_DB, // Database Gmail Penting
  
  // 5. Config Referral & Backup
  REFERRAL_COUNT_NEEDED, 
  REFERRAL_BONUS_FIX, 
  BACKUP_INTERVAL_HOURS, 
  BACKUP_COOLDOWN_START_HOURS,
  
  // 6. Media Assets
  START_IMAGE_FILE, 
  START_AUDIO_FILE, 
  SECONDARY_IMAGE_FILE 
} from './config.js';

// Inisialisasi bot Telegram
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PATH & DATA GLOBAL
const DATABASE_DIR = path.join(__dirname, 'database');
const REF_FILE_PATH = path.join(DATABASE_DIR, REFERRAL_DB);
const ROLES_FILE_PATH = path.join(DATABASE_DIR, "roles.json");
const USER_DB_PATH = path.join(DATABASE_DIR, USER_DB);
const LAST_BACKUP_FILE = path.join(DATABASE_DIR, "last_backup.txt");
const GMAIL_DB_PATH = path.join(DATABASE_DIR, GMAIL_DB); // <-- GMAIL DB PATH BARU

// GLOBAL VARIABLES DISIMPLIFIKASI (adminIds dan allowedIds dihapus/diabaikan)
let roleData = { owners: [], premiums: [] };
let lastBackupTimestamp = 0;

const DB_FILES = [
MT_FILE, PREMIUM_FILE, USER_DB, HISTORY_DB, 
  SETTINGS_DB, 'roles.json', REFERRAL_DB, GMAIL_DB
];
const userCooldowns = new Map();

// Variabel untuk koneksi WhatsApp (DIPERLUKAN UNTUK KOMPATIBILITAS KODE YANG MENGHAPUSNYA)
let whatsappSock = null;
let isWhatsAppConnected = false;
let reconnectAttempts = 0;
let qrCodeString = '';

function getWIBTime() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).replace(/\./g, ':');
}

// --- Fungsi Sleep (Jeda agar tidak kena Flood Limit Telegram) ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===================== FUNGSI UTILITAS DASAR (PENEMPATAN KRUSIAL) =====================

// Baca database
function readDb(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATABASE_DIR, file), 'utf8'));
  } catch (e) {
    return (file === REFERRAL_DB || file === USER_DB) ? {} : []; 
  }
}

// Tulis database
function writeDb(file, data) {
  fs.writeFileSync(path.join(DATABASE_DIR, file), JSON.stringify(data, null, 4), 'utf8');
}

// Inisialisasi file database (DIPINDAH KE ATAS)
function initDbFile(filePath, defaultData) {
  if (!fs.existsSync(path.join(DATABASE_DIR, filePath))) {
    fs.writeFileSync(path.join(DATABASE_DIR, filePath), JSON.stringify(defaultData, null, 4), 'utf8');
  }
}

// Inisialisasi semua file database (Memanggil initDbFile)
function initAllDb() {
  initDbFile(MT_FILE, []);
  initDbFile(PREMIUM_FILE, []);
  initDbFile(USER_DB, {});
  initDbFile(HISTORY_DB, []);
  initDbFile('owners.json', [OWNER_ID]);
  initDbFile('emails.json', []);
  initDbFile(SETTINGS_DB, {
    global_cooldown: 0,
    active_mt_id: 0,
    active_email_id: 0
  });
  initDbFile('roles.json', { owners: [], premiums: [] });
  initDbFile(REFERRAL_DB, {}); 
  initDbFile(GMAIL_DB, []); // <-- INISIALISASI GMAIL DB
}


// Helper functions (Access)
function isOwner(userId) {
  // PERBAIKAN: Memastikan OWNER_ID di-cast ke string agar kompatibel
  return userId.toString() === OWNER_ID.toString();
}

function isAdmin(userId) {
  // Sederhana: Admin dianggap sama dengan Owner Tambahan/Premium untuk akses command
  const uid = userId.toString();
  if (isOwner(userId)) return true;
  
  // Cek Owner Tambahan
  const isAddOwner = roleData.owners.some(o => o.id === uid && !isExpired(o.expireAt));
  if (isAddOwner) return true;

  // Cek Premium (Jika ingin premium juga bisa akses admin command)
  const isPrem = roleData.premiums.some(p => p.id === uid && !isExpired(p.expireAt));
  return isPrem;
}

function isAllowed(userId) {
  // Peran isAllowed dihapus dari struktur Role Management baru, tapi dipertahankan untuk kompatibilitas nama fungsi
  return isAdmin(userId) || isPremium(userId);
}

// Helper functions (Access Role Premium)
function isExpired(expireAt) {
    if (!expireAt) return true;
    if (expireAt === "permanent") return false;
    return Date.now() > expireAt;
}

// BARIS YANG DIPERBAIKI (MENGHILANGKAN PENGULANGAN 'function')
function isPremium(id) {
    const uid = id.toString();
    if (isOwner(uid)) return true;
    
    const prem = roleData.premiums.find(p => p.id.toString() === uid);
    if (!prem) return false;
    return !isExpired(prem.expireAt);
}

// Dapatkan Uptime
const getUptime = () => {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);
    return `${hours}h ${minutes}m ${seconds}s`;
};

// Parsing Durasi Role
function parseDuration(dur) {
    if (!dur) return null;
    const unit = dur.slice(-1).toLowerCase();
    const num = parseInt(dur);
    const now = Date.now();

    switch (unit) {
        case "d": return now + num * 24 * 60 * 60 * 1000;
        case "w": return now + num * 7 * 24 * 60 * 60 * 1000;
        case "m": return now + num * 30 * 24 * 60 * 60 * 1000;
        case "p": return "permanent";
        default: return null;
    }
}

function formatDurationText(expireAt) {
    if (expireAt === "permanent") return "Permanen";
    const sisa = expireAt - Date.now();
    const hari = Math.max(1, Math.ceil(sisa / (24 * 60 * 60 * 1000)));
    return `${hari} hari`;
}


// ========== FUNGSI UTILITAS LANJUTAN ==========

// Helper function untuk kirim error ke Owner (REVISI: Terminal Style)
async function sendOwnerError(ctx, error, context = 'Global Error') {
  // Gunakan jam WIB jika fungsi getWIBTime tersedia
  const time = typeof getWIBTime === 'function' ? getWIBTime() : new Date().toLocaleString();

  const errorMessage = 
    `<blockquote><b>𝚂𝚈𝚂𝚃𝙴𝙼 𝙲𝚁𝙸𝚃𝙸𝙲𝙰𝙻 𝙰𝙻𝙴𝚁𝚃</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `𝚄𝚂𝙴𝚁: @${ctx.from?.username || 'N/A'}\n` +
    `𝚄𝚂𝙴𝚁 𝙸𝙳: <code>${ctx.from?.id || 'N/A'}</code>\n` +
    `𝙲𝙷𝙰𝚃 𝙸𝙳: <code>${ctx.chat?.id || 'N/A'}</code>\n\n` +
    `𝙲𝙾𝙽𝚃𝙴𝚇𝚃: ${context}\n` +
    `𝙴𝚁𝚁𝙾𝚁: <code>${error.message}</code>\n\n` +
    `𝚃𝙸𝙼𝙴: ${time}</blockquote>`;

  try {
    await bot.telegram.sendMessage(OWNER_ID, errorMessage, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Gagal kirim error ke owner:', e);
  }
}


// Load roles
function loadRoles() {
    if (fs.existsSync(ROLES_FILE_PATH)) {
        try {
            roleData = JSON.parse(fs.readFileSync(ROLES_FILE_PATH));
            if (!Array.isArray(roleData.owners)) roleData.owners = [];
            if (!Array.isArray(roleData.premiums)) roleData.premiums = [];
        } catch (err) {
            console.error("⚠️ Gagal baca roles.json, reset data:", err.message);
            roleData = { owners: [], premiums: [] };
        }
    } else {
        roleData = { owners: [], premiums: [] };
    }
    saveRoles();
}

function saveRoles() {
    fs.writeFileSync(ROLES_FILE_PATH, JSON.stringify(roleData, null, 2));
}

// Load data allowed dan admin
function loadData() {
  // Logika loadData disederhanakan karena allowedIds/adminIds tidak dipakai lagi
  try {
    // const rawAllowed = fs.readFileSync(path.join(DATABASE_DIR, ALLOWED_FILE), 'utf8');
    // allowedIds = JSON.parse(rawAllowed);
  } catch (e) { /* allowedIds = []; */ }

  try {
    // const rawAdmin = fs.readFileSync(path.join(DATABASE_DIR, ADMIN_FILE), 'utf8');
    // adminIds = JSON.parse(rawAdmin);
  } catch (e) { /* adminIds = []; */ }
}

// Helper functions (Save)
function saveAllowed() {
  // Fungsi ini tidak lagi menyimpan data Allowed, hanya dummy/kosong
}

function saveAdmin() {
  // Fungsi ini tidak lagi menyimpan data Admin, hanya dummy/kosong
}

// Dapatkan user data (Dipertahankan untuk struktur DB lama)
function getUser(userId) {
  const users = readDb(USER_DB);
  const defaultUser = {
    id: userId,
    username: 'N/A',
    status: isOwner(userId) ? 'owner' : 'free',
    is_banned: 0,
    last_fix: 0,
    fix_limit: 10,
    referral_points: 0,
    referred_by: null,
  };
  return users[userId] ? { ...defaultUser, ...users[userId] } : defaultUser;
}

// index.js (Tambahkan di bagian fungsi utility, sekitar baris 300)

// Fungsi baru untuk memastikan user ada di database USER_DB
function createUserIfNotExist(userId, username) {
    const users = readDb(USER_DB);
    const userIdStr = userId.toString();
    
    if (!users[userIdStr]) {
        const defaultUser = {
            id: userIdStr,
            username: username || 'N/A',
            status: isOwner(userId) ? 'owner' : 'free',
            is_banned: 0,
            last_fix: 0,
            fix_limit: 0, // Default 0 karena limit kini dikelola di referral_db/bonusChecks
            referral_points: 0,
            referred_by: null,
            join_date: new Date().toISOString(),
        };
        users[userIdStr] = defaultUser;
        writeDb(USER_DB, users);
        console.log(`✅ New user registered in USER_DB: ${userIdStr}`);
        return true;
    }
    // Update username jika berubah
    if (users[userIdStr].username !== username) {
        users[userIdStr].username = username || 'N/A';
        writeDb(USER_DB, users);
    }
    return false;
}

// Simpan user data (Dipertahankan untuk struktur DB lama)
function saveUser(user) {
  const users = readDb(USER_DB);
  users[user.id] = user;
  writeDb(USER_DB, users);
}

// Simpan history
function saveHistory(data) {
  const history = readDb(HISTORY_DB);
  const historyArray = Array.isArray(history) ? history : []; 
  const newId = historyArray.length > 0 ? historyArray[historyArray.length - 1].id + 1 : 1;
  
  // REVISI: Ganti timestamp jadi WIB
  historyArray.push({ id: newId, ...data, timestamp: getWIBTime() });
  
  writeDb(HISTORY_DB, historyArray);
}

// Load Referral
function loadRefs() {
    if (!fs.existsSync(REF_FILE_PATH)) {
        fs.writeFileSync(REF_FILE_PATH, JSON.stringify({}));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(REF_FILE_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveRefs(data) {
    fs.writeFileSync(REF_FILE_PATH, JSON.stringify(data, null, 2));
}

// Helper functions for Gmail Accounts
function getGmailAccounts() {
  if (!fs.existsSync(GMAIL_DB_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(GMAIL_DB_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveGmailAccounts(data) {
  fs.writeFileSync(GMAIL_DB_PATH, JSON.stringify(data, null, 4), 'utf8');
}

// Fungsi untuk mendapatkan sender berikutnya secara round-robin
function getNextSender() {
  const accounts = getGmailAccounts();
  if (accounts.length === 0) return null;
  
  const settings = readDb(SETTINGS_DB);
  let activeId = settings.active_email_id || 0;
  
  const currentIds = accounts.map(acc => acc.id);
  
  let currentIndex = currentIds.indexOf(activeId);

  // Jika ID aktif tidak ditemukan, atau ini adalah panggilan pertama/sudah di akhir list
  if (currentIndex === -1 || currentIndex >= accounts.length - 1) {
    currentIndex = 0;
  } else {
    // Pindah ke index berikutnya
    currentIndex += 1;
  }
  
  const nextSender = accounts[currentIndex];
  
  // Update SETTINGS_DB dengan ID sender berikutnya
  settings.active_email_id = nextSender.id;
  writeDb(SETTINGS_DB, settings);
  
  return nextSender;
}


// FUNGSI INI DIGANTI TOTAL (LOGIKA REFERRAL LAMA)
// Fungsi untuk memproses referral saat /start pertama
// HANYA mencatat referrer-nya, belum memberikan bonus.
async function processReferral(ctx, referrerId, newUserId) {
  const newUserIdStr = newUserId.toString();
  const referrerIdStr = referrerId.toString();

  // 1. Cek validitas: Tidak bisa refer diri sendiri atau referrerId kosong
  if (referrerIdStr === newUserIdStr || !referrerIdStr) return;
  
  const refs = loadRefs();

  // 2. Cek apakah user baru sudah pernah di-refer
  if (refs[newUserIdStr] && refs[newUserIdStr].referredBy) {
    return;
  }

  // 3. Catat referrerId untuk user baru
  if (!refs[newUserIdStr]) {
    // Inisialisasi data user baru jika belum ada
    refs[newUserIdStr] = { invited: [], bonusChecks: 0, totalInvited: 0, referredBy: referrerIdStr };
  } else {
    // Jika data ada tapi belum ada referredBy
    refs[newUserIdStr].referredBy = referrerIdStr;
  }
  
  saveRefs(refs);

  // 4. Notifikasi ke Referrer (Hanya info, belum dapat bonus)
  const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  try {
      await ctx.telegram.sendMessage(
          referrerIdStr,
          `<blockquote>📢 <b>𝙽𝚘𝚝𝚒𝚏𝚒𝚔𝚊𝚜𝚒 𝚁𝚎𝚏𝚎𝚛𝚛𝚊𝚕</b>\n👤 ${userName} ʙᴀʀᴜ sᴀᴊᴀ ᴊᴏɪɴ ᴍᴇɴɢɢᴜɴᴀᴋᴀɴ ʟɪɴᴋ ʀᴇғᴇʀʀᴀʟ ᴋᴀᴍᴜ. ʙᴏɴᴜs ʙᴇʟᴜᴍ ᴅɪʙᴇʀɪᴋᴀɴ ɪᴀ ʜᴀʀᴜs ᴍᴇɴʏᴇʟᴇsᴀɪᴋᴀɴ ᴠᴇʀɪғɪᴋᴀsɪ ᴋᴇᴀɴɢɢᴏᴛᴀᴀɴ ɢʀᴜᴘ + ᴄʜᴀɴɴᴇʟ ᴛᴇʀʟᴇʙɪʜ ᴅᴀʜᴜʟᴜ.</blockquote>`,
          { parse_mode: 'HTML' }
      );
  } catch (err) {
      console.warn(`⚠️ Gagal kirim notif join ke ${referrerIdStr}:`, err.message);
  }
}


// FUNGSI BARU UNTUK MEMBERIKAN BONUS SETELAH LOLOS VERIFIKASI
async function checkAndGrantReferralBonus(ctx, newUserId) {
    const newUserIdStr = newUserId.toString();
    const refs = loadRefs();
    
    // 1. Cek apakah user ini di-refer oleh seseorang (memiliki referredBy ID)
    if (!refs[newUserIdStr] || !refs[newUserIdStr].referredBy) return false;
    
    const referrerIdStr = refs[newUserIdStr].referredBy;
    
    // 2. Pastikan data referrer ada (inisialisasi jika belum ada)
    if (!refs[referrerIdStr]) {
        refs[referrerIdStr] = { invited: [], bonusChecks: 0, totalInvited: 0 };
    }
    
    // 3. Cek apakah user baru sudah tercatat di 'invited' referrer (bonus sudah pernah diberikan/diproses)
    if (refs[referrerIdStr].invited.includes(newUserIdStr)) return false; 

    // 4. Tambahkan user baru ke daftar invited (Resmi tercatat karena lolos verifikasi keanggotaan)
    refs[referrerIdStr].invited.push(newUserIdStr);
    
    // 5. Hitung dan berikan bonus limit
    const invitedCount = refs[referrerIdStr].invited.length;
    
    // Hitung total bonus yang *seharusnya* sudah didapat (dalam unit REFERRAL_BONUS_FIX)
    const totalBonusesEarned = Math.floor(invitedCount / REFERRAL_COUNT_NEEDED) * REFERRAL_BONUS_FIX;
    
    const currentTotalInvited = refs[referrerIdStr].totalInvited || 0;
    
    // Bandingkan: Jika bonus yang seharusnya > dari yang sudah dicatat (bonus baru didapat)
    if (totalBonusesEarned > currentTotalInvited) {
        const newBonus = totalBonusesEarned - currentTotalInvited;
        
        // Update total bonus yang dicatat dan limit bonusChecks
        refs[referrerIdStr].bonusChecks = (refs[referrerIdStr].bonusChecks || 0) + newBonus;
        refs[referrerIdStr].totalInvited = totalBonusesEarned;
        
        saveRefs(refs); // Simpan perubahan setelah bonus diberikan

        // Notifikasi ke Referrer: Bonus diberikan
        try {
            await ctx.telegram.sendMessage(
                referrerIdStr, 
                `🎉 **𝙍𝙀𝙁𝙀𝙍𝙍𝘼𝙇 𝘽𝙊𝙉𝙐𝙎 𝘿𝙄𝙏𝙀𝙍𝙄𝙈𝘼** 🎉\n\n` + 
                `User yang diundang: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name} telah lolos verifikasi keanggotaan !\n` +
                `Total ${invitedCount} user berhasil Anda undang.\n` + 
                `Anda mendapatkan **+${newBonus}** limit /fix.`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) { 
            console.error(`Gagal kirim bonus notif ke ${referrerIdStr}:`, e); 
        }
    } else {
        // Simpan perubahan invited list meskipun belum dapat bonus limit
        saveRefs(refs);
    }

    return true; 
}


// Cek apakah user sudah join grup dan channel yang wajib. (Membutuhkan isOwner & isPremium)
async function checkGroupAndChannelMembership(userId) {
  if (isOwner(userId) || isPremium(userId)) return true;

  try {
    const groupMember = await bot.telegram.getChatMember(VERIFICATION_GROUP_USERNAME, userId);
    const inGroup = groupMember && (groupMember.status === 'member' || groupMember.status === 'administrator' || groupMember.status === 'creator');
    
    const channelMember = await bot.telegram.getChatMember(VERIFICATION_CHANNEL_USERNAME, userId);
    const inChannel = channelMember && (channelMember.status === 'member' || channelMember.status === 'administrator' || channelMember.status === 'creator');

    if (inGroup && inChannel) {
        // Logika saveAllowed dihilangkan karena menggunakan RoleData
        return true;
    }

    return false;

  } catch (error) {
    // Jika error code 400 (user not found in chat), kita asumsikan user belum join.
    if (error.response?.error_code !== 400) {
      console.warn(`⚠️ Gagal cek keanggotaan untuk user ${userId}. Error: ${error.message}`);
    }
    return false;
  }
}

// Fungsi untuk kirim email via API Vercel (MODIFIKASI: Menerima kredensial dinamis)
async function sendViaAPI(emailData, sender_user, sender_pass) {
  try {
    // Tambahkan sender_user dan sender_pass ke body request
    const requestBody = { 
        ...emailData, 
        sender_user: sender_user,
        sender_pass: sender_pass
    };

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify(requestBody) // <-- GUNAKAN requestBody
    });

    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.message || `HTTP error! status: ${response.status}`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error API Vercel:', error);
    throw new Error(`Gagal terhubung ke server: ${error.message}`);
  }
}

// Dapatkan MT texts
function getMtTexts() {
  const mt = readDb(MT_FILE);
  return Array.isArray(mt) ? mt : [];
}

// Dapatkan MT text by ID
function getMtTextById(id) {
  const mtTexts = getMtTexts();
  return mtTexts.find(mt => mt.id === id);
}

// Dapatkan active MT
function getActiveMt() {
  const settings = readDb(SETTINGS_DB);
  const activeId = settings.active_mt_id || 0;
  return getMtTextById(activeId);
}


// ===================== AUTO BACKUP LOGIC (REVISI TOTAL) =====================

async function createBackupZip(isStartBackup = false) {
  const date = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_');
  const backupFolder = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupFolder)) fs.mkdirSync(backupFolder);

  const fileName = `backup_${date}.zip`;
  const filePath = path.join(backupFolder, fileName);
  const output = fs.createWriteStream(filePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  // Update last backup timestamp
  fs.writeFileSync(LAST_BACKUP_FILE, Date.now().toString());
  lastBackupTimestamp = Date.now();
  
  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      let success = true;
      try {
                 // --- Logika PENGIRIMAN WAJIB (Selalu kirim ke owner) ---
          // REVISI: Gunakan getWIBTime()
          const captionText = isStartBackup 
              ? `✅ **𝙱𝙰𝙲𝙺𝚄𝙿 𝙿𝙴𝚁 /𝚂𝚃𝙰𝚁𝚃 𝙱𝙴𝚁𝙷𝙰𝚂𝙸𝙻**\n\n📅 𝚆𝚊𝚔𝚝𝚞: ${getWIBTime()}`
              : `✅ **𝙱𝙰𝙲𝙺𝚄𝙿 𝙾𝚃𝙾𝙼𝙰𝚃𝙸𝚂 𝙱𝙴𝚁𝙷𝙰𝚂𝙸𝙻**\n\n📅 𝚆𝚊𝚔𝚝𝚞: ${getWIBTime()}`;
          await bot.telegram.sendDocument(OWNER_ID, { source: filePath }, { 
            caption: captionText,
            parse_mode: 'Markdown'
          });
          
          console.log(`✅ Backup sent to owner for type: ${isStartBackup ? 'START' : 'CRON'}.`);
          // --- Akhir Logika PENGIRIMAN WAJIB ---
          
      } catch (e) {
          console.error(`❌ Gagal kirim backup ke owner (${isStartBackup ? 'START' : 'CRON'}):`, e.message);
          success = false;
      } finally {
          // --- Logika PENGHAPUSAN WAJIB (Selalu hapus) ---
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath); // Hapus file zip lokal (baik berhasil kirim maupun tidak)
            console.log('🗑️ Backup file deleted locally.');
          }
          // --- Akhir Logika PENGHAPUSAN WAJIB ---
      }
      resolve(success);
    });
    
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    DB_FILES.forEach(file => {
      const fullPath = path.join(DATABASE_DIR, file);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: file });
      } else {
        console.warn(`File DB tidak ditemukan: ${file}`);
      }
    });

    archive.finalize();
  });
}

async function startAutomaticBackup() {
  console.log(`⏱️ Automatic Backup Scheduled: Every ${BACKUP_INTERVAL_HOURS} hours`);
  
  cron.schedule(`0 */${BACKUP_INTERVAL_HOURS} * * *`, async () => {
    console.log('🔄 Starting scheduled backup...');
    try {
      await createBackupZip(false);
    } catch (error) {
      console.error('❌ Gagal melakukan backup otomatis:', error);
      try {
        await bot.telegram.sendMessage(OWNER_ID, `❌ <b>BACKUP GAGAL</b>\n\n🚨 Error: <code>${error.message}</code>`, { parse_mode: 'HTML' });
      } catch (e) { /* ignore */ }
    }
  });
}


// ===================== COMMAND /FIX (FITUR UTAMA) =====================

bot.command('fix', async (ctx) => {
  const userId = ctx.message.from.id;
  const userIdStr = userId.toString();
  const username = ctx.message.from.username || ctx.message.from.first_name;

  // --- [KODE BARU MULAI] ---
  // Cek Cooldown (Kecuali Owner & Premium)
  if (!isOwner(userId) && !isPremium(userId)) {
      const lastUsed = userCooldowns.get(userId);
      if (lastUsed) {
          const now = Date.now();
          const remainingTime = lastUsed + FIX_COOLDOWN - now;

          if (remainingTime > 0) {
              const minutes = Math.ceil(remainingTime / 60000);
              return ctx.reply(
                  `<blockquote>⏳ <b>COOLDOWN AKTIF</b>\n\nMohon tunggu <b>${minutes} menit</b> lagi sebelum menggunakan perintah /fix kembali.</blockquote>`, 
                  { parse_mode: 'HTML' }
              );
          }
      }
  }

  // Cek Wajib Join Grup/Channel 
  if (!isOwner(userId) && !isPremium(userId) && !(await checkGroupAndChannelMembership(userId))) {
    return ctx.reply(`<blockquote>🚫 <b>Kamu belum join semua tempat wajib!</b>\n📢 Channel: <a href="https://t.me/${VERIFICATION_CHANNEL_USERNAME.replace('@', '')}">${VERIFICATION_CHANNEL_USERNAME}</a>\n👥 Group: <a href="https://t.me/${VERIFICATION_GROUP_USERNAME.replace('@', '')}">${VERIFICATION_GROUP_USERNAME}</a></blockquote>`,
        { parse_mode: 'HTML', 
          reply_markup: Markup.inlineKeyboard([
            [{ text: '𝙅𝙊𝙄𝙉 𝘾𝙃𝘼𝙉𝙉𝙀𝙇', url: `https://t.me/${VERIFICATION_CHANNEL_USERNAME.replace('@', '')}` }],
            [{ text: '𝙅𝙊𝙄𝙉 𝙂𝙍𝙊𝙐𝙋', url: `https://t.me/${VERIFICATION_GROUP_USERNAME.replace('@', '')}` }]
          ]) 
        });
  }
  
  const messageText = ctx.message.text;
  const args = messageText.replace('/fix', '').trim().split(/\s+/);
  
  if (args.length === 0 || !args[0]) {
    return ctx.reply('<blockquote>❌ Format salah. Format: <code>/fix &lt;nomor_whatsapp&gt;</code>\n\n📝 Contoh: <code>/fix 628123456789</code></blockquote>', { parse_mode: 'HTML' });
  }

    // --- LOGIKA NORMALISASI NOMOR (REVISI SUPPORT INTERNASIONAL) ---
  let number = args[0].replace(/[^0-9+]/g, ''); // Hapus karakter selain angka dan +

  // 1. Jika user pakai '+', kita hormati inputnya (hapus + nya saja)
  if (number.startsWith('+')) {
    number = number.substring(1);
  }
  // 2. Jika dimulai '08' (Format Lokal Baku Indo) -> Ubah ke 628
  else if (number.startsWith('08')) {
    number = '62' + number.substring(1);
  }
  // 3. Jika dimulai '62' (Format Internasional Indo) -> Biarkan
  else if (number.startsWith('62')) {
    // Pass (sudah benar)
  }
  // 4. Jika dimulai '8' DAN panjangnya >= 10 (Format Lokal Indo Malas) -> Ubah ke 628
  // Kita cek length >= 10 untuk menghindari konflik dengan negara kode pendek
  else if (number.startsWith('8') && number.length >= 10) { 
    number = '62' + number;
  }
  // 5. SELAIN ITU (Nomor Luar Negeri tanpa +) -> BIARKAN APA ADANYA
  // Contoh: 996 (Kyrgyzstan), 1 (USA), 44 (UK), 7 (Russia) akan masuk sini tanpa diubah.
  else {
     // Trust User Input
  }

  // Validasi panjang minimum (Nomor dunia bisa pendek, min 7 digit aman)
  if (number.length < 7 || number.length > 15) {
    return ctx.reply('<blockquote>❌ Format nomor tidak valid (7-15 digit).</blockquote>', { parse_mode: 'HTML' });
  }

  // Cek user data dan limit. Pastikan user diinisialisasi di refs.
  const refs = loadRefs();
  if (!refs[userIdStr]) {
    // Inisialisasi hanya untuk akses data, referral logic handled by processReferral/checkAndGrantReferralBonus
    refs[userIdStr] = { invited: [], bonusChecks: 0, totalInvited: 0 }; 
  }
  const refUser = refs[userIdStr];
  const currentLimit = refUser.bonusChecks || 0;
  
  
  if (!isOwner(userId) && !isPremium(userId) && currentLimit <= 0) {
    const referralLink = `https://t.me/${ctx.botInfo.username}?start=ref${userId}`;
    
    // REVISI: Menampilkan link mentah (kode) dan link yang dapat diklik (tag <a>)
    return ctx.reply(
        `<blockquote>❌ <b>Limit /fix</b> Anda (${currentLimit}x).\n\n` +
        `Undang ${REFERRAL_COUNT_NEEDED} teman Anda untuk mendapatkan <b>+${REFERRAL_BONUS_FIX}</b> limit!\n` +
        `\n🔗 <b>Link Referral Anda:</b>\n` +
        `<code>${referralLink}</code>\n` +
        `</blockquote>`, 
        { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true 
        }
    );
  }

  // Dapatkan MT aktif
  const activeTemplate = getActiveMt();
  if (!activeTemplate) {
    await ctx.reply('<blockquote>❌ Tidak ada template banding yang aktif. Silakan hubungi owner.</blockquote>', { parse_mode: 'HTML' });
    await sendOwnerError(ctx, new Error('Tidak ada MT aktif saat /fix'), 'MT Not Found');
    return;
  }

  // --- Dapatkan Akun Pengirim Round-Robin ---
  const senderAccount = getNextSender(); // <-- Ambil sender berikutnya
  if (!senderAccount) {
    return ctx.reply('<blockquote>❌ Tidak ada akun Gmail pengirim yang terdaftar. Silakan tambahkan akun dengan /addgmail.</blockquote>', { parse_mode: 'HTML' });
  }
  // ------------------------------------------

  try {
    const body = activeTemplate.body.replace(/{nomor}/g, number);
    
    const emailData = {
      to_email: activeTemplate.to_email, subject: activeTemplate.subject, body: body,
      number: number, user_id: userId.toString(), username: username
    };

    // Panggil API dengan kredensial sender
    const apiResult = await sendViaAPI(
        emailData, 
        senderAccount.user,   // <-- KIRIM USERNAME
        senderAccount.pass    // <-- KIRIM PASSWORD
    ); 
    
    // *** Update limit HANYA jika pengiriman API sukses ***
    if (!isOwner(userId) && !isPremium(userId)) {
      if (currentLimit > 0) {
        refUser.bonusChecks -= 1; // Mengurangi data di refs[userIdStr]
        saveRefs(refs);
      }
    }

    // Simpan history
    saveHistory({
      user_id: userId,
      username: username,
      command: `/fix ${number}`,
      number_fixed: number.replace('+', ''),
      email_used: senderAccount.user, // <-- Log sender yang digunakan
      details: `Berhasil mengirim banding MT ID ${activeTemplate.id} ke ${activeTemplate.to_email} via API (Sender: ${senderAccount.user})`
    });

        // Tampilkan limit setelah dikurangi
    const isFreeUser = !isOwner(userId) && !isPremium(userId);
    const limitAfterFix = isFreeUser && currentLimit > 0 ? (currentLimit - 1) : currentLimit;
    
    // REVISI: Font Typewriter KAPITAL (Uppercase)
    await ctx.reply(
      `<blockquote>𝙰𝙿𝙿𝙴𝙰𝙻 𝚂𝙴𝙽𝚃 𝚂𝚄𝙲𝙲𝙴𝚂𝚂𝙵𝚄𝙻𝙻𝚈\n` +
      `𝚃𝙰𝚁𝙶𝙴𝚃: <code>${number}</code>\n\n` +
      `𝚂𝙴𝙽𝙳𝙴𝚁 𝙸𝙳: <code>${senderAccount.id}</code>\n` +
      `𝚃𝙾 𝙼𝙰𝙸𝙻: ${activeTemplate.to_email}\n` +
      `𝚂𝚄𝙱𝙹𝙴𝙲𝚃: ${activeTemplate.subject}\n` +
      `𝙼𝙴𝚃𝙷𝙾𝙳: 𝙰𝙿𝙸 𝚅𝙴𝚁𝙲𝙴𝙻\n` +
      `𝙻𝙸𝙼𝙸𝚃: ${isFreeUser ? limitAfterFix + 'x' : '∞'}\n\n` +
      `𝚂𝚃𝙰𝚃𝚄𝚂: ${apiResult.message || 'Sent!'}</blockquote>`,
      { parse_mode: 'HTML' }
    );
// Simpan waktu sekarang agar cooldown berjalan
    userCooldowns.set(userId, Date.now());
  } catch (error) {
    console.error('❌ Error mengirim banding via API:', error);
    
    // Simpan History Error
    saveHistory({
      user_id: userId,
      username: username,
      command: `/fix ${number}`,
      number_fixed: number.replace('+', ''),
      email_used: senderAccount ? senderAccount.user : 'Unknown',
      details: `Gagal mengirim banding: ${error.message}`
    });
    
    // Kirim Alert Keren ke Owner
    await sendOwnerError(ctx, error, 'API Vercel Error');

    // Tentukan ID Sender (Jika error terjadi sebelum senderAccount didefinisikan, pakai 'N/A')
    const senderId = senderAccount ? senderAccount.id : '𝙽/𝙰';

    // REVISI: Tampilan Error User (Terminal Style)
    await ctx.reply(
      `<blockquote>❌ 𝙰𝙿𝙿𝙴𝙰𝙻 𝚂𝙴𝙽𝙳𝙸𝙽𝙶 𝙵𝙰𝙸𝙻𝙴𝙳\n` +
      `𝚃𝙰𝚁𝙶𝙴𝚃: <code>${number}</code>\n\n` +
      `𝚂𝙴𝙽𝙳𝙴𝚁 𝙸𝙳: <code>${senderId}</code>\n` +
      `𝙴𝚁𝚁𝙾𝚁: ${error.message}\n\n` +
      `𝙿𝙻𝙴𝙰𝚂𝙴 𝙲𝙷𝙴𝙲𝙺 𝚈𝙾𝚄𝚁 𝙸𝙽𝙿𝚄𝚃 𝙾𝚁 𝙲𝙾𝙽𝚃𝙰𝙲𝚃 𝙰𝙳𝙼𝙸𝙽.</blockquote>`, 
      { parse_mode: 'HTML' }
    );
  }
});


// ===================== COMMAND /INFO (Perbaikan Link Referral) =====================

bot.command('info', async (ctx) => {
  const userId = ctx.message.from.id.toString();
  const user = ctx.message.from;
  
  // Pastikan user diinisialisasi di refs saat /info
  const refs = loadRefs();
  if (!refs[userId]) {
    refs[userId] = { invited: [], bonusChecks: 0, totalInvited: 0 }; // Limit Awal jadi 0x
    saveRefs(refs); // Simpan jika ini adalah user baru
  }
  const refUser = refs[userId];
  
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=ref${userId}`;
  const referredCount = Array.isArray(refUser.invited) ? refUser.invited.length : 0;
  
  // Ambil Status Role
  const ownerData = roleData.owners.find(o => o.id === userId && !isExpired(o.expireAt));
  const premiumData = roleData.premiums.find(p => p.id === userId && !isExpired(p.expireAt));

  const ownerStatus = ownerData ? `OWNER (${formatDurationText(ownerData.expireAt)})` : "NON OWNER";
  const premiumStatus = premiumData ? `PREMIUM (${formatDurationText(premiumData.expireAt)})` : "NON PREMIUM";

  const userInfo = 
    `<blockquote>📊 <b>𝙄𝙉𝙁𝙊𝙍𝙈𝘼𝙎𝙄 𝘼𝙆𝙐𝙉 𝙁𝙄𝙓 𝘼𝙋𝙄</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `<b>Nama:</b> ${user.first_name || 'N/A'}\n` +
    `<b>ID:</b> <code>${user.id}</code>\n` +
    `<b>Username:</b> @${user.username || 'Tidak ada'}\n` +
    `────────────────────\n` +
    `<b>Status Owner:</b> ${ownerStatus}\n` +
    `<b>Status Premium:</b> ${premiumStatus}\n` +
    `<b>Limit Fix:</b> ${isOwner(userId) || isPremium(userId) ? '∞' : refUser.bonusChecks + 'x'}\n` +
    `🤝 <b>Total Undangan:</b> ${referredCount} orang\n` +
    `────────────────────\n` +
    `🔗 <b>Link Undanganmu:</b> <code>${referralLink}</code>\n` + // PERBAIKAN: Menampilkan link mentah
    `💡 <i>Undang ${REFERRAL_COUNT_NEEDED} teman untuk menambah ${REFERRAL_BONUS_FIX}x limit!</i>` +
    `</blockquote>`;

  await ctx.reply(userInfo, { 
    parse_mode: 'HTML',
    reply_to_message_id: ctx.message.message_id,
    disable_web_page_preview: true,
  });
});


// ===================== COMMAND /START & CALLBACK =====================

// Fungsi untuk membuat markup menu utama (Meniru Skrip 2)
function getMainMenuMarkup(userId) {
  const isOwnerStatus = isOwner(userId);
  const isAdminStatus = isAdmin(userId);

  const keyboard = [];

  // Baris 1: Menu Owner / Admin (Gabung jadi satu tombol jika Owner/Admin)
  if (isOwnerStatus || isAdminStatus) {
    keyboard.push([{ text: '𝗢𝗪𝗡𝗘𝗥 𝗠𝗘𝗡𝗨', callback_data: 'owner_menu' }]);
  }

  // Baris 2: Menu Fix (Menggantikan MENU WHATSAPP)
  keyboard.push([{ text: '𝗙𝗜𝗫 𝗠𝗘𝗡𝗨', callback_data: 'menu_fix' }]);
  
  // Baris 3: Menu More
  keyboard.push([{ text: '𝗠𝗘𝗡𝗨 𝗠𝗢𝗥𝗘', callback_data: 'menu_more' }]);

  // Baris 4: Developer
  keyboard.push([{ text: '𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗢𝗪𝗡𝗘𝗥', url: USERNAME_OWNER.replace('@', 'https://t.me/') }]);

  return { inline_keyboard: [keyboard.slice(0, 2), keyboard.slice(2, 3), keyboard.slice(3, 4)].flat() };
}

// Fungsi Helper untuk mengirim menu start secara penuh (Foto + Audio + Text)
async function sendFullStartMenu(ctx, sendAudio = true) { // Tambahkan parameter sendAudio
    const userId = ctx.from.id;
    const imagePath = path.join(DATABASE_DIR, START_IMAGE_FILE);
    const audioPath = path.join(DATABASE_DIR, START_AUDIO_FILE);
    
    const text = `<blockquote>𝙏𝙊𝙊𝙇𝙎 𝙒𝙃𝘼𝙏𝙎𝘼𝙋𝙋 
━━━━━━━━━━━━━━━━━━━━
ɪ ᴀᴍ ᴀ ʀᴇᴅ ғɪx ʙᴏᴛᴅᴇsɪɢɴᴇᴅ ᴛᴏ ᴍᴀᴋᴇ ɪᴛ ᴇᴀsɪᴇʀ ᴡʜᴇɴ ɢᴀᴄʜᴀ ɴᴜᴍʙᴇʀs, ᴘʟᴇᴀsᴇ. ᴄʟɪᴄᴋ ᴛʜᴇ ʙᴜᴛᴛᴏɴ ᴛᴏ ᴜsᴇ ᴛʜᴇ ғᴇᴀᴛᴜʀᴇ
    
╭───═⊱ ( 𝙄𝙉𝙁𝙊𝙍𝙈𝘼𝙏𝙄𝙊𝙉 ) ⬣
│ 𝚄𝚂𝙴𝚁 : @${ctx.from.username || 'N/A'}
│ 𝙸𝙳 : <code>${userId}</code>
│ 𝙽𝙰𝙼𝙴 𝙱𝙾𝚃 : 𝙵𝙸𝚇 𝚁𝙴𝙳
│ 𝙳𝙴𝚅 : ${USERNAME_OWNER}
│ 𝙾𝙽𝙻𝙸𝙽𝙴 : ${getUptime()}
╰──────────────────────═⪼
ᴄʟɪᴄᴋ ᴛʜᴇ ʙᴜᴛᴛᴏɴ ᴛᴏ sᴇᴇ ᴛʜᴇ ᴍᴇɴᴜ.
</blockquote>`;

    const replyOptions = {
        parse_mode: 'HTML',
        reply_markup: getMainMenuMarkup(userId)
    };

    try {
        // Kirim Foto + Text
        if (fs.existsSync(imagePath)) {
            await ctx.replyWithPhoto({ source: imagePath }, { caption: text, ...replyOptions });
        } else {
            await ctx.reply(text, replyOptions);
        }
        
        // Kirim Audio (Hanya jika sendAudio true)
        if (sendAudio && fs.existsSync(audioPath)) {
            await ctx.replyWithAudio(
                { source: audioPath },
                {
                    title: '.⋆♱ ᴄᴏʀʟᴇᴏɴᴇ', // <-- FONT BARU
                    performer: 'ᯓ★ 𝚏𝚘𝚛?', // <-- FONT BARU
                    caption: '𝑍𝑒𝑙𝑙 𝑢𝑟 𝑓𝑎𝑣𝑣', // <-- FONT BARU
                }
            );
        }
    } catch (error) {
        console.error('Error saat mengirim full start menu:', error);
        await ctx.reply('❌ Gagal menampilkan menu dengan media. Silakan coba lagi.', { parse_mode: 'HTML' });
        await sendOwnerError(ctx, error, 'Send Full Menu Error');
    }
}


// Handler /start
bot.command('start', async (ctx) => {
  const userId = ctx.message.from.id;
  const userIdStr = userId.toString();
  const username = ctx.message.from.username || ctx.message.from.first_name;

  // --- TAMBAHAN WAJIB: SIMPAN USER KE DATABASE ---
  createUserIfNotExist(userId, username);

  // 1. Logika Backup per Start (REVISI: Menangani Error)
  const now = Date.now();
  const oneHour = BACKUP_COOLDOWN_START_HOURS * 60 * 60 * 1000;
  if (now - lastBackupTimestamp > oneHour) {
      try {
          await createBackupZip(true);
      } catch (e) {
          console.error("❌ Gagal backup per /start:", e.message);
      }
  }
  
  // 2. Proses Referral
  const messageText = ctx.message.text;
  const match = messageText.match(/\/start ref(\d+)/);
  if (match) {
    const referrerId = parseInt(match[1]);
    await processReferral(ctx, referrerId.toString(), userIdStr);
  }

  // Cek Keanggotaan Grup/Channel (untuk verifikasi awal) & Terapkan Pembatasan!
  const isMember = await checkGroupAndChannelMembership(userId);
  
  if (isOwner(userId) || isPremium(userId) || isMember) {
      // --- BARU DITAMBAHKAN ---
      await checkAndGrantReferralBonus(ctx, userId); 
      // ------------------------
      
      // Kirim Menu Penuh (dengan Audio) HANYA JIKA OWNER/PREMIUM/MEMBER
      await sendFullStartMenu(ctx, true);
       } else {
      const imagePath = path.join(DATABASE_DIR, START_IMAGE_FILE); 

      return ctx.replyWithPhoto(
        { source: imagePath }, 
        {
          caption: `<blockquote>𝙰𝙲𝙲𝙴𝚂𝚂 𝙳𝙴𝙽𝙸𝙴𝙳
𝚃𝙾 𝚄𝚂𝙴 𝚃𝙷𝙴 𝙱𝙾𝚃, 𝙿𝙻𝙴𝙰𝚂𝙴 𝚁𝙴𝙰𝙳 𝚃𝙷𝙴 𝚁𝚄𝙻𝙴𝚂 𝙱𝙴𝙻𝙾𝚆: 

1. 𝙹𝙾𝙸𝙽 𝙰 𝙲𝙷𝙰𝙽𝙽𝙴𝙻 𝙰𝙽𝙳 𝙶𝚁𝙾𝚄𝙿.
2. 𝙸𝙽𝚅𝙸𝚃𝙴 𝙵𝚁𝙸𝙴𝙽𝙳𝚂 𝚅𝙸𝙰 𝚁𝙴𝙵𝙴𝚁𝚁𝙰𝙻 𝙵𝙾𝚁 𝙵𝚁𝙴𝙴 𝙿𝙾𝙸𝙽𝚃𝚂.

𝙾𝙽𝙲𝙴 𝚈𝙾𝚄'𝚅𝙴 𝙵𝙾𝙻𝙻𝙾𝚆𝙴𝙳 𝚃𝙷𝙴 𝚂𝚃𝙴𝙿𝚂 𝙰𝙱𝙾𝚅𝙴, 𝚈𝙾𝚄 𝙲𝙰𝙽 𝙲𝙾𝙽𝚃𝙸𝙽𝚄𝙴 𝚄𝚂𝙸𝙽𝙶 𝚃𝙷𝙴 𝙱𝙾𝚃.

© 𝐶𝑜𝑟𝑙𝑒𝑜𝑛𝑒 𝐸𝑙𝑣𝑎𝑟𝑒𝑡𝑡𝑒
</blockquote>`,
          parse_mode: 'HTML', 
          //
          ...Markup.inlineKeyboard([
            [{ text: '𝗝𝗢𝗜𝗡 𝗖𝗛𝗔𝗡𝗡𝗘𝗟', url: `https://t.me/${VERIFICATION_CHANNEL_USERNAME.replace('@', '')}` }],
            [{ text: '𝗝𝗢𝗜𝗡 𝗚𝗥𝗢𝗨𝗣', url: `https://t.me/${VERIFICATION_GROUP_USERNAME.replace('@', '')}` }],
            [{ text: '𝗗𝗢𝗡𝗘𝗘', callback_data: 'back_to_start' }]
          ]) 
        }
      );
  }
});

// Fungsi Helper untuk mengirim Menu Sekunder dengan Foto (Hapus Pesan Lama + Kirim Baru)
async function sendSecondaryMenu(ctx, text, keyboard) {
    const imagePath = path.join(DATABASE_DIR, SECONDARY_IMAGE_FILE);
    const chatId = ctx.chat.id;
    const messageId = ctx.callbackQuery.message.message_id; // Ambil ID pesan yang akan dihapus

    // 1. Hapus pesan lama (callback)
    try {
        await ctx.telegram.deleteMessage(chatId, messageId);
    } catch (e) {
        console.warn('Gagal menghapus pesan lama (mungkin sudah terhapus):', e.message);
    }
    
    // 2. Kirim pesan baru dengan foto dan menu
    try {
        if (fs.existsSync(imagePath)) {
             await ctx.telegram.sendPhoto(chatId, { source: imagePath }, { 
                caption: text, 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
             });
        } else {
             await ctx.telegram.sendMessage(chatId, text, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
             });
        }
    } catch (e) {
        console.error('Gagal mengirim menu sekunder:', e.message);
        await ctx.reply('❌ Gagal menampilkan menu. Silakan ketik /start lagi.', { parse_mode: 'HTML' });
    }
}

// Handler Callback Query untuk menu
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const userIdStr = userId.toString();
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  
  const backToStartButton = [{ text: '𝐵𝐴𝐶𝐾', callback_data: 'back_to_start' }];
  
  // Pengecekan Keanggotaan di 'back_to_start'
  if (data === 'back_to_start') {
      const isMember = await checkGroupAndChannelMembership(userId);
      const chatId = ctx.chat.id;
      
      if (isOwner(userId) || isPremium(userId) || isMember) {
          // --- BARU DITAMBAHKAN ---
          await checkAndGrantReferralBonus(ctx, userId); 
          // ------------------------

          // Hapus pesan lama
          try {
              await ctx.deleteMessage();
          } catch (e) {
              console.warn('Gagal menghapus pesan lama (back_to_start):', e.message);
          }
          await sendFullStartMenu(ctx, false); // Kirim menu penuh tanpa audio
          return;
           } else {
      const imagePath = path.join(DATABASE_DIR, START_IMAGE_FILE); 

      return ctx.replyWithPhoto(
        { source: imagePath }, 
        {
          caption: `<blockquote>𝙰𝙲𝙲𝙴𝚂𝚂 𝙳𝙴𝙽𝙸𝙴𝙳
𝚃𝙾 𝚄𝚂𝙴 𝚃𝙷𝙴 𝙱𝙾𝚃, 𝙿𝙻𝙴𝙰𝚂𝙴 𝚁𝙴𝙰𝙳 𝚃𝙷𝙴 𝚁𝚄𝙻𝙴𝚂 𝙱𝙴𝙻𝙾𝚆: 

1. 𝙹𝙾𝙸𝙽 𝙰 𝙲𝙷𝙰𝙽𝙽𝙴𝙻 𝙰𝙽𝙳 𝙶𝚁𝙾𝚄𝙿.
2. 𝙸𝙽𝚅𝙸𝚃𝙴 𝙵𝚁𝙸𝙴𝙽𝙳𝚂 𝚅𝙸𝙰 𝚁𝙴𝙵𝙴𝚁𝚁𝙰𝙻 𝙵𝙾𝚁 𝙵𝚁𝙴𝙴 𝙿𝙾𝙸𝙽𝚃𝚂.

𝙾𝙽𝙲𝙴 𝚈𝙾𝚄'𝚅𝙴 𝙵𝙾𝙻𝙻𝙾𝚆𝙴𝙳 𝚃𝙷𝙴 𝚂𝚃𝙴𝙿𝚂 𝙰𝙱𝙾𝚅𝙴, 𝚈𝙾𝚄 𝙲𝙰𝙽 𝙲𝙾𝙽𝚃𝙸𝙽𝚄𝙴 𝚄𝚂𝙸𝙽𝙶 𝚃𝙷𝙴 𝙱𝙾𝚃.
© 𝑍𝑒𝑙𝑙 𝑢𝑟 𝑓𝑎𝑣𝑣
</blockquote>`,
          parse_mode: 'HTML', 
          //
          ...Markup.inlineKeyboard([
            [{ text: '𝗝𝗢𝗜𝗡 𝗖𝗛𝗔𝗡𝗡𝗘𝗟', url: `https://t.me/${VERIFICATION_CHANNEL_USERNAME.replace('@', '')}` }],
            [{ text: '𝗝𝗢𝗜𝗡 𝗚𝗥𝗢𝗨𝗣', url: `https://t.me/${VERIFICATION_GROUP_USERNAME.replace('@', '')}` }],
            [{ text: '𝗗𝗢𝗡𝗘𝗘', callback_data: 'back_to_start' }]
          ]) 
        } 
      );
  }
};

  const isOwnerStatus = isOwner(userId);
  const isAdminStatus = isAdmin(userId);

  // Jika user free mencoba mengakses menu sebelum join, blokir
  if (!isOwnerStatus && !isPremium(userId) && !(await checkGroupAndChannelMembership(userId))) {
      return ctx.answerCbQuery('Akses dibatasi. Silakan gabung ke channel dan grup wajib.');
  }
  
  let text = '';
  let keyboard = [];

  // Logic untuk menu sekunder (Hapus & Kirim Baru)
  switch (data) {
    case 'menu_fix':
      // Pastikan user diinisialisasi di refs saat mengakses menu fix
      const refs = loadRefs();
      if (!refs[userIdStr]) {
        refs[userIdStr] = { invited: [], bonusChecks: 0, totalInvited: 0 }; // Limit Awal jadi 0x
        saveRefs(refs);
      }
      const refUser = refs[userIdStr];
      
      text = `<blockquote>╔─═⊱ 𝙼𝙴𝙽𝚄 𝙵𝙸𝚇 ─═⬣
║⁀➴ /info
║╰┈➤ ɪɴғᴏ ʟɪᴍɪᴛ & ʀᴇғᴇʀᴀʟ
║⁀➴ /fix 628xxxxxxxx
║╰┈➤ sᴇɴᴅ ʙᴀɴᴅɪɴɢ ᴠɪᴀ ᴀᴘɪ
╚━═━═━═━═━═━═━═━═━═━═⪼
\nLimit Anda: ${isOwner(userId) || isPremium(userId) ? '∞' : (refUser.bonusChecks || 0) + 'x'}</blockquote>`;
      keyboard.push(backToStartButton);
      break;

    case 'menu_more':
      text = `<blockquote>╔─═⊱ 𝙼𝙴𝙽𝚄 𝙼𝙾𝚁𝙴 ─═⬣
║⁀➴ /tourl
║╰┈➤ ᴍᴇᴅɪᴀ ᴛᴏ ᴜʀʟ
╚━═━═━═━═━═━═━═━═━═━═⪼</blockquote>`;
      keyboard.push(backToStartButton);
      break;
      
    case 'owner_menu':
      if (!isOwnerStatus && !isAdminStatus) return;
      text = `<blockquote>╔─═⊱ 𝙼𝙴𝙽𝚄 𝙾𝚆𝙽𝙴𝚁 / 𝙰𝙳𝙼𝙸𝙽 ─═⬣
║ /bc
║╰┈➤ ᴍᴇssᴀɢᴇ ᴛᴏ ᴀʟʟ ʙᴏᴛ ᴜsᴇʀs 
║ /totaluser 
║╰┈➤ ᴄᴇᴄᴋ ᴛᴏᴛᴀʟ ᴜsᴇʀ
║ /listprem 
║╰┈➤ ʟɪsᴛ ᴜsᴇʀ ᴘʀᴇᴍɪᴜᴍ
║ /addprem 
║╰┈➤ ᴀᴅᴅ ᴀᴋsᴇs ᴘʀᴇᴍɪᴜᴍ
║ /delprem 
║╰┈➤ ᴅᴇʟᴇᴛᴇ ᴀᴋsᴇs ᴘʀᴇᴍɪᴜᴍ
║ /listowner
║╰┈➤ ʟɪsᴛ ᴀᴋsᴇs ᴏᴡɴᴇʀ
║ /addowner
║╰┈➤ ᴀᴅᴅ ᴏᴡɴᴇʀ
║ /delowner 
║╰┈➤ ᴅᴇʟᴇᴛᴇ ᴏᴡɴᴇʀ
║ /setmt 
║╰┈➤ ᴛᴀᴍʙᴀʜ ᴛᴇᴍᴘʟᴇᴛᴇ
║ /setactivemt 
║╰┈➤ sᴡɪᴛᴄʜ ᴛᴇᴍᴘʟᴇᴛᴇ
║ /listmt 
║╰┈➤ ʟɪsᴛ ᴛᴇᴍᴘʟᴇᴛᴇ
║ /addgmail 
║╰┈➤ ᴀᴅᴅ ɢᴍᴀɪʟ sᴇɴᴅᴇʀ
║ /listgmail 
║╰┈➤ ʟɪsᴛ ɢᴍᴀɪʟ sᴇɴᴅᴇʀ
║ /delgmail 
║╰┈➤ ᴅᴇʟᴇᴛᴇ ɢᴍᴀɪʟ
╚━═━═━═━═━═━═━═━═━═━═⪼</blockquote>`; // <-- TAMBAHAN COMMAND GMAIL
      keyboard.push(backToStartButton);
      break;
          
    default:
        return;
  }
  
  // Kirim menu sekunder yang baru (Hapus pesan lama & kirim baru dengan foto)
  if (text) {
      await sendSecondaryMenu(ctx, text, keyboard);
  }
});


// ===================== COMMAND UTILITIES =====================

bot.command('totaluser', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) return ctx.reply(`<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇɴᴊᴀʟᴀɴᴋᴀɴ ᴘᴇʀɪɴᴛᴀʜ ɪɴɪ.</blockquote>`, { parse_mode: "HTML" });

  try {
    const users = readDb(USER_DB);
    const total = Object.keys(users).length;
    return ctx.reply(`<blockquote><b>𝙏𝙤𝙩𝙖𝙡 𝙋𝙚𝙣𝙜𝙜𝙪𝙣𝙖 𝘽𝙤𝙩</b>\n\n👤 𝙅𝙪𝙢𝙡𝙖𝙝 𝙐𝙨𝙚𝙧: <b>${total}</b></blockquote>`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Error totaluser:', e);
    await sendOwnerError(ctx, e, 'TotalUser Read Error');
    return ctx.reply('<blockquote>⚠️ Gagal menghitung total user. Database mungkin ʙᴇʀᴍᴀsᴀʟᴀʜ.</blockquote>', { parse_mode: 'HTML' });
  }
});

bot.command(['bc', 'broadcast'], async (ctx) => {
  const userId = ctx.from.id;
  // Cek apakah pengirim adalah Owner
  if (!isOwner(userId)) return ctx.reply('<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇʟᴀᴋᴜᴋᴀɴ ʙʀᴏᴀᴅᴄᴀsᴛ.</blockquote>', { parse_mode: 'HTML' });

  // 1. Ambil data semua user dari database
  const users = readDb(USER_DB); 
  const userIds = Object.keys(users); // Ambil daftar ID user
  const totalUsers = userIds.length;

  // Jika database kosong
  if (totalUsers === 0) return ctx.reply('⚠️ Belum ada user terdaftar di database (users.json kosong).');

  // 2. Cek Jenis Pesan (Reply atau Text Manual?)
  let msgType = '';
  let msgContent = null; 

  if (ctx.message.reply_to_message) {
    // Jika admin me-reply sebuah pesan (Gambar/Video/Sticker/File)
    msgType = 'reply';
    msgContent = ctx.message.reply_to_message.message_id;
  } else {
    // Jika admin mengetik teks: /bc halo semua
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) {
      return ctx.reply(
        '<blockquote>⚠️ <b>𝙁𝙤𝙧𝙢𝙖𝙩 𝙎𝙖𝙡𝙖𝙝!</b>\n\n' +
        '1. <b>Reply</b> sebuah pesan (foto/video/text) dengan <code>/bc</code>\n' +
        '2. Atau ketik: <code>/bc Pesan Anda Disini</code></blockquote>', 
        { parse_mode: 'HTML' }
      );
    }
    msgType = 'text';
    msgContent = text;
  }

  // 3. Konfirmasi Awal
  await ctx.reply(`<blockquote>🚀 <b>Memulai Broadcast...</b>\n\n👥 Target: ${totalUsers} User\n⏳ Estimasi: ${Math.ceil(totalUsers * 0.2)} detik\n\nMohon tunggu laporan selesai...</blockquote>`, { parse_mode: 'HTML' });

  let success = 0;
  let failed = 0;
  let blocked = 0;

  // 4. Loop Pengiriman ke Setiap User
  for (const id of userIds) {
    try {
      if (msgType === 'reply') {
        // Copy pesan apapun (foto/video/dll) ke user target
        await bot.telegram.copyMessage(id, ctx.chat.id, msgContent);
      } else {
        // Kirim teks biasa
        await bot.telegram.sendMessage(id, msgContent);
      }
      success++;
    } catch (error) {
      failed++;
      // Cek error 403 (User memblokir bot)
      if (error.response && error.response.error_code === 403) {
        blocked++;
      }
      console.log(`Gagal BC ke ${id}: ${error.message}`);
    }

    // --- PENTING: JEDA 100ms AGAR AMAN DARI BANNED ---
    await sleep(100); 
  }

  // 5. Laporan Akhir
  const report = `<blockquote>✅ <b>𝘽𝙍𝙊𝘼𝘿𝘾𝘼𝙎𝙏 𝙎𝙐𝘾𝘾𝙀𝙎</b>\n\n` +
                 `𝚃𝚘𝚝𝚊𝚕 𝚃𝚊𝚛𝚐𝚎𝚝: ${totalUsers}\n` +
                 `𝙱𝚎𝚛𝚑𝚊𝚜𝚒𝚕: <b>${success}</b>\n` +
                 `𝙶𝚊𝚐𝚊𝚕: <b>${failed}</b> (Blokir: ${blocked})\n` +
                 `𝚆𝚊𝚔𝚝𝚞: ${getWIBTime()}</blockquote>`;

  await ctx.reply(report, { parse_mode: 'HTML' });
});


// Command Admin & Owner - Role Management (addprem/delprem/listprem)
bot.command('addprem', async (ctx) => {
  const fromId = ctx.from.id.toString();
  if (!isOwner(fromId)) return ctx.reply("<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇɴᴊᴀʟᴀɴᴋᴀɴ ᴘᴇʀɪɴᴛᴀʜ ɪɴɪ.!</blockquote>", {
    parse_mode: "HTML"
  });

  const args = ctx.message.text.split(" ").slice(1);
  const targetId = args[0];
  const durasi = args[1];

  if (!targetId || !durasi)
    return ctx.reply(
      "<blockquote>⚠️ ɢᴜɴᴀᴋᴀɴ ғᴏʀᴍᴀᴛ:\n<code>/addprem user_id durasi</code>\n\n🧩 Contoh:\n<code>/addprem 12345678 7d</code>\n<code>/addprem 12345678 p</code></blockquote>",
      { parse_mode: "HTML" }
    );
  
  if (isNaN(parseInt(targetId))) return ctx.reply("<blockquote>❌ ɪᴅ ᴛᴀʀɢᴇᴛ ʜᴀʀᴜs ʙᴇʀᴜᴘᴀ ᴀɴɢᴋᴀ.</blockquote>", { parse_mode: "HTML" });

  const expireAt = parseDuration(durasi);
  if (!expireAt) return ctx.reply(`<blockquote>⚠️ ᴅᴜʀᴀsɪ ᴛɪᴅᴀᴋ ᴠᴀʟɪᴅ! ɢᴜɴᴀᴋᴀɴ ᴅ/ᴡ/ᴍ/ᴘ.</blockquote>`, {
    parse_mode: "HTML"
  });

  roleData.premiums = roleData.premiums.filter(p => p.id !== targetId);
  roleData.premiums.push({ id: targetId, expireAt, startAt: Date.now() });
  saveRoles();

  const waktu = formatDurationText(expireAt);

  await ctx.reply(`<blockquote>✨ User <code>${targetId}</code> sekarang Premium selama <b>${waktu}</b>!</blockquote>`, { parse_mode: "HTML" });

  try {
    await ctx.telegram.sendMessage(
      targetId,
      `<blockquote>🎉 <b>sᴇʟᴀᴍᴀᴛ!</b>\nᴀɴᴅᴀ ᴛᴇʟᴀʜ ᴍᴇɴᴊᴀᴅɪ <b>ᴘʀᴇᴍɪᴜᴍ ᴜsᴇʀ</b>!\n\n🕒 ᴡᴀᴋᴛᴜ ᴀᴋᴛɪғ: <b>${waktu}</b>\n\nsᴇʟᴀᴍᴀᴛ ᴍᴇɴɢɢᴜɴᴀᴋᴀɴ ʟᴀʏᴀɴᴀɴ ʙᴏᴛ ᴋᴀᴍɪ 🚀</blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch {
    ctx.reply("⚠️ ᴛɪᴅᴀᴋ ʙɪsᴀ ᴋɪʀɪᴍ ᴘᴇsᴀɴ ᴋᴇ ᴜsᴇʀ (ᴍᴜɴɢᴋɪɴ ʙᴇʟᴜᴍ sᴛᴀʀᴛ ʙᴏᴛ).");
  }
});

bot.command("delprem", async (ctx) => {
  const fromId = ctx.from.id.toString();
  if (!isOwner(fromId)) return ctx.reply(`<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇɴɢʜᴀᴘᴜs ᴜsᴇʀ ᴘʀᴇᴍɪᴜᴍ.</blockquote>`, {
    parse_mode: "HTML"
  });

  const args = ctx.message.text.split(" ").slice(1);
  const targetId = args[0];

  if (!targetId)
    return ctx.reply(
      "<blockquote>⚠️ Gunakan format:\n<code>/delprem user_id</code>\n\n🧩 Contoh:\n<code>/delprem 12345678</code></blockquote>",
      { parse_mode: "HTML"
      }
    );
  
  if (isNaN(parseInt(targetId))) return ctx.reply("<blockquote>❌ ɪᴅ ᴛᴀʀɢᴇᴛ ʜᴀʀᴜs ʙᴇʀᴜᴘᴀ ᴀɴɢᴋᴀ.</blockquote>", { parse_mode: "HTML" });


  const before = roleData.premiums.length;
  roleData.premiums = roleData.premiums.filter(p => p.id !== targetId);
  saveRoles();

  if (roleData.premiums.length === before)
    return ctx.reply(`<blockquote>❌ User <code>${targetId}</code> tidak ditemukan di daftar premium.</blockquote>`, { parse_mode: "HTML" });

  ctx.reply(`<blockquote>✅ User <code>${targetId}</code> telah dihapus dari daftar Premium.</blockquote>`, { parse_mode: "HTML" });
});

bot.command("listprem", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId))
    return ctx.reply("<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇʟɪʜᴀᴛ ᴅᴀғᴛᴀʀ ᴘʀᴇᴍɪᴜᴍ!</blockquote>", { parse_mode: "HTML" });

  const data = roleData.premiums.filter(p => !isExpired(p.expireAt));
  if (data.length === 0)
    return ctx.reply("<blockquote>📭 𝘽𝙚𝙡𝙪𝙢 𝙖𝙙𝙖 𝙪𝙨𝙚𝙧 𝙋𝙧𝙚𝙢𝙞𝙪𝙢 𝙖𝙠𝙩𝙞𝙛.</blockquote>", { parse_mode: "HTML" });

  let text = "<blockquote>📜 <b>𝘿𝙖𝙛𝙩𝙖𝙧 𝙐𝙨𝙚𝙧 𝙋𝙧𝙚𝙢𝙞𝙪𝙢 𝘼𝙠𝙩𝙞𝙛</b>\n━━━━━━━━━━━━━━━━━━\n";

  for (const user of data) {
    const { id, expireAt } = user;
    const waktu = formatDurationText(expireAt);
    text += `👤 <b>ID:</b> <code>${id}</code>\n⏱ <b>Sisa:</b> ${waktu}\n\n`;
  }
  text += "</blockquote>";

  await ctx.reply(text, { parse_mode: "HTML" });
});


bot.command('addowner', async (ctx) => {
  const fromId = ctx.from.id.toString();
  const OWNER_ID_STR = OWNER_ID.toString();

  if (fromId !== OWNER_ID_STR) return ctx.reply("<blockquote>🚫 ʜᴀɴʏᴀ ᴏᴡɴᴇʀ ᴜᴛᴀᴍᴀ ʏᴀɴɢ ʙɪsᴀ ᴍᴇɴᴊᴀʟᴀɴᴋᴀɴ ᴘᴇʀɪɴᴛᴀʜ ɪɴɪ!</blockquote>", {
    parse_mode: "HTML"
  });

  const args = ctx.message.text.split(" ").slice(1);
  const targetId = args[0];
  const durasi = args[1];

  if (!targetId || !durasi)
    return ctx.reply(
      "<blockquote>⚠️ Gunakan format:\n<code>/addowner user_id durasi</code>\n\n🧩 Contoh:\n<code>/addowner 12345678 p</code></blockquote>",
      { parse_mode: "HTML"
      }
    );
  
  if (isNaN(parseInt(targetId))) return ctx.reply("<blockquote>❌ ɪᴅ ᴛᴀʀɢᴇᴛ ʜᴀʀᴜs ʙᴇʀᴜᴘᴀ ᴀɴɢᴋᴀ.</blockquote>", { parse_mode: "HTML" });


  const expireAt = parseDuration(durasi);
  if (!expireAt) return ctx.reply("⚠️ Durasi tidak valid! Gunakan d/w/m/p.");

  roleData.owners = roleData.owners.filter(o => o.id !== targetId);
  roleData.owners.push({ id: targetId, expireAt, startAt: Date.now() });
  saveRoles();

  const waktu = formatDurationText(expireAt);

  await ctx.reply(`<blockquote>✅ User <code>${targetId}</code> berhasil jadi <b>Owner</b> selama <b>${waktu}</b>!</blockquote>`, { parse_mode: "HTML" });

  try {
    await ctx.telegram.sendMessage(
      targetId,
      `<blockquote>👑 <b>Selamat!</b>\nAnda telah menjadi <b>Owner Bot</b>!\n\n🕒 Waktu aktif: <b>${waktu}</b>\n\nSelamat menikmati fitur eksklusif kami 🙌</blockquote>`,
      { parse_mode: "HTML"
      }
    );
  } catch {
    ctx.reply("<blockquote>⚠️ Tidak bisa kirim pesan ke user (mungkin belum start bot).</blockquote>", {
      parse_mode: "HTML"
    });
  }
});

bot.command("delowner", async (ctx) => {
  const fromId = ctx.from.id.toString();
  const OWNER_ID_STR = OWNER_ID.toString();

  if (fromId !== OWNER_ID_STR)
    return ctx.reply("<blockquote>🚫 Hanya owner utama yang bisa menjalankan perintah ini!</blockquote>", {
    parse_mode: "HTML"
  });

  const args = ctx.message.text.split(" ").slice(1);
  const targetId = args[0];

  if (!targetId)
    return ctx.reply(
      "<blockquote>⚠️ Gunakan format:\n<code>/delowner user_id</code>\n\n🧩 Contoh:\n<code>/delowner 12345678</code></blockquote>",
      { parse_mode: "HTML"
      }
    );
  
  if (isNaN(parseInt(targetId))) return ctx.reply("<blockquote>❌ ID target harus berupa angka.</blockquote>", { parse_mode: "HTML" });


  const before = roleData.owners.length;
  roleData.owners = roleData.owners.filter(o => o.id !== targetId);
  saveRoles();

  if (roleData.owners.length === before)
    return ctx.reply(`<blockquote>❌ User <code>${targetId}</code> tidak ditemukan di daftar owner.</blockquote>`, { parse_mode: "HTML" });

  ctx.reply(`<blockquote>✅ User <code>${targetId}</code> telah dihapus dari daftar Owner.</blockquote>`, { parse_mode: "HTML" });
});

bot.command("listowner", async (ctx) => {
  const userId = ctx.from.id.toString();
  const OWNER_ID_STR = OWNER_ID.toString();

  if (userId !== OWNER_ID_STR)
    return ctx.reply("<blockquote>🚫 Hanya owner utama yang bisa melihat daftar Owner!</blockquote>", { parse_mode: "HTML" });

  const data = roleData.owners.filter(o => !isExpired(o.expireAt));
  if (data.length === 0)
    return ctx.reply("<blockquote>📭 Belum ada owner tambahan aktif.</blockquote>", { parse_mode: "HTML" });

  let text = "<blockquote><b>Daftar Owner Tambahan Aktif</b>\n━━━━━━━━━━━━━━━━━━\n";
  text += `👤 <b>Owner Utama:</b> <code>${OWNER_ID_STR}</code>\n\n`;

  for (const user of data) {
    const { id, expireAt } = user;
    const waktu = formatDurationText(expireAt);
    text += `👤 <b>ID:</b> <code>${id}</code>\n⏱ <b>Sisa:</b> ${waktu}\n\n`;
  }
  text += "</blockquote>";

  await ctx.reply(text, { parse_mode: "HTML" });
});

// ===================== COMMAND GMAIL MANAGEMENT =====================

// Command /addgmail (REVISI: Auto Remove Spaces & Clean Input)
bot.command('addgmail', async (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return ctx.reply('<blockquote>🚫 Hanya owner yang bisa menjalankan perintah ini.</blockquote>', { parse_mode: "HTML" });

  // 1. Pecah input berdasarkan spasi
  const args = ctx.message.text.trim().split(/\s+/);
  // args[0] = /addgmail
  // args[1] = email
  // args[2] dst = potongan password (jika ada spasi)

  const user = args[1];
  
  // 2. Ambil semua sisa potongan setelah email, gabung, lalu HAPUS SEMUA SPASI
  const rawPass = args.slice(2).join('');
  const pass = rawPass.replace(/\s/g, ''); 

  if (!user || !pass) {
    return ctx.reply('<blockquote>❌ Format: <code>/addgmail email@gmail.com password_aplikasi</code>\n\n⚠️ Masukkan App Password 16 digit. Spasi akan otomatis dihapus oleh bot.</blockquote>', { parse_mode: "HTML" });
  }

  const accounts = getGmailAccounts();
  const existing = accounts.find(acc => acc.user === user);
  if (existing) {
    return ctx.reply('<blockquote>❌ Akun Gmail ini sudah terdaftar.</blockquote>', { parse_mode: "HTML" });
  }
  
  const newId = accounts.length > 0 ? accounts[accounts.length - 1].id + 1 : 1;
  accounts.push({ id: newId, user, pass, addedAt: Date.now() });
  saveGmailAccounts(accounts);

  await ctx.reply(`<blockquote>✅ <b>Akun Gmail Berhasil Ditambahkan!</b>\n\n🆔 ID: <b>${newId}</b>\n📧 Email: <code>${user}</code>\n🔑 Pass (Clean): <code>${pass}</code>\n\nPassword otomatis dibersihkan agar login sukses.</blockquote>`, { parse_mode: "HTML" });
});

// Command /listgmail
bot.command('listgmail', async (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return ctx.reply('<blockquote>🚫 Hanya owner yang bisa menjalankan perintah ini.</blockquote>', { parse_mode: "HTML" });

  const accounts = getGmailAccounts();
  if (accounts.length === 0) {
    return ctx.reply('<blockquote>📋 Tidak ada akun Gmail pengirim terdaftar.</blockquote>', { parse_mode: "HTML" });
  }
  
  const settings = readDb(SETTINGS_DB);
  const activeId = settings.active_email_id;

  let text = '<blockquote>📧 <b>Daftar Akun Pengirim Gmail</b>\n━━━━━━━━━━━━━━━━━━\n';
  
  accounts.forEach(acc => {
    const status = acc.id === activeId ? '✅ (Aktif)' : '(Idle)';
    text += `🆔 <b>ID:</b> <code>${acc.id}</code> ${status}\n`;
    text += `👤 <b>User:</b> <code>${acc.user}</code>\n`;
    text += `🗓 <b>Ditambahkan:</b> ${new Date(acc.addedAt).toLocaleDateString('id-ID')}\n\n`;
  });
  text += '</blockquote>';
  
  await ctx.reply(text, { parse_mode: "HTML" });
});

// Command /delgmail
bot.command('delgmail', async (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return ctx.reply('<blockquote>🚫 Hanya owner yang bisa menjalankan perintah ini.</blockquote>', { parse_mode: "HTML" });

  const args = ctx.message.text.split(" ").slice(1);
  const targetId = parseInt(args[0]);

  if (isNaN(targetId)) {
    return ctx.reply('<blockquote>❌ Format: <code>/delgmail &lt;id&gt;</code></blockquote>', { parse_mode: "HTML" });
  }

  let accounts = getGmailAccounts();
  const initialLength = accounts.length;
  accounts = accounts.filter(acc => acc.id !== targetId);
  
  if (accounts.length === initialLength) {
    return ctx.reply(`<blockquote>❌ Akun Gmail ID <code>${targetId}</code> tidak ditemukan.</blockquote>`, { parse_mode: "HTML" });
  }

  saveGmailAccounts(accounts);
  await ctx.reply(`<blockquote>✅ Akun Gmail ID <b>${targetId}</b> berhasil dihapus.</blockquote>`, { parse_mode: "HTML" });
});

// ===================== COMMAND MT MANAGEMENT =====================

bot.command('setmt', async (ctx) => { 
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('<blockquote>❌ Hanya owner yang bisa mengatur MT.</blockquote>', { parse_mode: 'HTML' });
  }

  const messageText = ctx.message.text;
  const parts = messageText.replace('/setmt', '').trim().split('|').map(p => p.trim());

  if (parts.length < 3) {
    return ctx.reply('<blockquote>❌ Format: <code>/setmt &lt;email_tujuan&gt; | &lt;subjek&gt; | &lt;isi_pesan&gt;</code></blockquote>', { parse_mode: 'HTML' });
  }

  const [to_email, subject, body] = parts;

  if (!body.includes('{nomor}')) {
    return ctx.reply('<blockquote>❌ Isi pesan wajib mengandung <code>{nomor}</code> untuk placeholder nomor WhatsApp.</blockquote>', { parse_mode: 'HTML' });
  }

  try {
      const mtTextsArray = getMtTexts();
      const newId = mtTextsArray.length > 0 ? mtTextsArray[mtTextsArray.length - 1].id + 1 : 1;

      mtTextsArray.push({ id: newId, to_email, subject, body });
      writeDb(MT_FILE, mtTextsArray);
        
      await ctx.reply(`<blockquote>✅ MT ID <b>${newId}</b> berhasil ditambahkan.\nSubjek: ${subject}\nEmail Tujuan: ${to_email}</blockquote>`, { parse_mode: 'HTML' });

  } catch (e) {
      console.error('Error setmt:', e);
      await sendOwnerError(ctx, e, 'SetMT Write Error');
      return ctx.reply('<blockquote>⚠️ Gagal menyimpan template.</blockquote>', { parse_mode: 'HTML' });
  }
});

bot.command('setactivemt', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('<blockquote>❌ Hanya owner yang bisa mengatur MT aktif.</blockquote>', { parse_mode: 'HTML' });
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('<blockquote>❌ Format: <code>/setactivemt &lt;id_mt&gt;</code></blockquote>', { parse_mode: 'HTML' });
  }

  const id = parseInt(args[0]);
  if (isNaN(id)) {
      return ctx.reply('<blockquote>❌ ID MT harus berupa angka.</blockquote>', { parse_mode: 'HTML' });
  }

  try {
      const mtText = getMtTextById(id);

      if (!mtText) {
        return ctx.reply(`<blockquote>❌ MT ID ${id} tidak ditemukan.</blockquote>`, { parse_mode: 'HTML' });
      }

      const settings = readDb(SETTINGS_DB);
      settings.active_mt_id = id;
      writeDb(SETTINGS_DB, settings);

      await ctx.reply(`<blockquote>✅ Template banding aktif disetel ke <b>ID ${id}</b> (Subjek: ${mtText.subject})</blockquote>`, { parse_mode: 'HTML' });
  } catch (e) {
      console.error('Error setactivemt:', e);
      await sendOwnerError(ctx, e, 'SetActiveMT Write Error');
      return ctx.reply('<blockquote>⚠️ Gagal menyimpan pengaturan.</blockquote>', { parse_mode: 'HTML' });
  }
});

bot.command('listmt', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('<blockquote>❌ Hanya owner yang bisa melihat daftar MT.</blockquote>', { parse_mode: 'HTML' });
  }

  try {
      const mtTextsArray = getMtTexts();
      const settings = readDb(SETTINGS_DB);
      const activeId = settings.active_mt_id;

      if (mtTextsArray.length === 0) {
        return ctx.reply('<blockquote>📋 Tidak ada template banding yang tersedia.</blockquote>', { parse_mode: 'HTML' });
      }

      let text = `<blockquote>📋 <b>Daftar Template Banding</b>:\n\n`;
      mtTextsArray.forEach(mt => {
        text += `ID: <code>${mt.id}</code> ${mt.id === activeId ? '✅' : ''}\n`;
        text += `Subjek: ${mt.subject}\n`;
        text += `Email: ${mt.to_email}\n`;
        text += `--- \n`;
      });
      text += '</blockquote>';

      await ctx.reply(text, { parse_mode: 'HTML' });
  } catch (e) {
      console.error('Error listmt:', e);
      await sendOwnerError(ctx, e, 'ListMT Read Error');
      return ctx.reply('<blockquote>⚠️ Gagal membaca data template.</blockquote>', { parse_mode: 'HTML' });
  }
});

// Command /delwa (Dipertahankan sebagai placeholder)
bot.command('delwa', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menghapus session WhatsApp.');
  }
  
  await ctx.reply(
    '<blockquote>⚠️ <b>Fitur koneksi WhatsApp telah dinonaktifkan!</b>\n\nFokus bot saat ini adalah pada fitur /fix (banding API) saja.</blockquote>',
    { parse_mode: 'HTML' }
  );
});


// Command More
bot.command('cekid', async (ctx) => {
    // Logika /cekid yang menghasilkan file PNG dihapus total
    return ctx.reply(`<blockquote>🛠️ Fitur /cekid di sini masih dalam pengembangan. Silakan gunakan /info untuk ID Anda.</blockquote>`, { parse_mode: 'HTML' });
});

bot.command('tourl', async (ctx) => {
    // Logika /tourl dihapus total
    return ctx.reply(`<blockquote>🛠️ Fitur /tourl di sini masih dalam pengembangan.</blockquote>`, { parse_mode: 'HTML' });
});


// Handler error bot Telegram 
bot.catch(async (error, ctx) => {
  console.error('❌ Error Telegram Bot:', error);
  
  await sendOwnerError(ctx, error, 'Bot Catch Error');

  try {
    await ctx.reply('❌ Terjadi kesalahan sistem. Silakan coba lagi atau hubungi admin.').catch(e => {
      console.error('Gagal kirim pesan error ke user:', e);
    });
  } catch (e) {
    // Ignore errors in error handler
  }
});


// Start semua services
async function startAll() {
  try {
    console.log('🚀 Starting Telegram Bot...');
    
    // Inisialisasi database
    if (!fs.existsSync(DATABASE_DIR)) fs.mkdirSync(DATABASE_DIR);
    if (fs.existsSync(LAST_BACKUP_FILE)) {
      lastBackupTimestamp = parseInt(fs.readFileSync(LAST_BACKUP_FILE, 'utf8'));
    }
    
    // URUTAN SUDAH DIKOREKSI
    initAllDb(); 
    loadData(); // Memuat data lama (meskipun tidak terpakai)
    loadRoles(); // Memuat role data baru
    
    startAutomaticBackup();
    
    await bot.launch();
    console.log('✅ Telegram Bot berhasil dijalankan');
    
        // Kirim notifikasi BOT ACTIVE ke OWNER_ID (HTML)
    try {
      await bot.telegram.sendMessage(
        OWNER_ID,
        `<blockquote>🤖 <b>𝘽𝙊𝙏 𝘼𝘾𝙏𝙄𝙑𝙀</b> ✅✅\n\n` +
        `𝚆𝚊𝚔𝚝𝚞: ${getWIBTime()}\n` + // REVISI: Pakai WIB
        `𝚂𝚝𝚊𝚝𝚞𝚜: 𝙾𝚗𝚕𝚒𝚗𝚎 𝚍𝚊𝚗 𝚜𝚒𝚊𝚙 𝚍𝚒𝚐𝚞𝚗𝚊𝚔𝚊𝚗\n\n` +
        `*𝙵𝚘𝚔𝚞𝚜 𝚋𝚘𝚝 𝚙𝚊𝚍𝚊 /𝚏𝚒𝚡 (𝚋𝚊𝚗𝚍𝚒𝚗𝚐 𝙰𝙿𝙸) 𝚜𝚊𝚓𝚊.*</blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Gagal kirim notifikasi ke owner:', error);
    }
    
  } catch (error) {
    console.error('❌ Gagal memulai bot:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stop();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stop();
  process.exit(0);
});

// Start the bot
startAll();
