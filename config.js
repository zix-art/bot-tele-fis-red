// ========== KONFIGURASI BOT ==========

// 1. Identitas Bot & Owner
const TELEGRAM_BOT_TOKEN = '8724563891:AAF8WZ3aSXnTz0JySKT07Y2yJd4UOn8KPa0'; 
const OWNER_ID = 7883659934;
const USERNAME_OWNER = '@scuttlelollipopss'; 

// 2. Syarat Join (Channel & Group)
const VERIFICATION_GROUP_USERNAME = '@BaseComunityChat'; 
const VERIFICATION_CHANNEL_USERNAME = '@comercianto'; 

// 3. Konfigurasi API Email (Vercel)
const API_URL = 'https://botfixred.vercel.app/api/send-email'; //Jangan Diubah Ya Bre
const API_KEY = 'beckk001'; //Jangan Diubah Ya Bre
const COOLDOWN_DURATION = 300000; 
const COOLDOWN_TIME = 1000 * 1000; 
const MAX_RECONNECT_ATTEMPTS = 10;
const FIX_COOLDOWN = 2 * 60 * 1000;

// 4. Sistem Referral & Backup
const REFERRAL_COUNT_NEEDED = 1; 
const REFERRAL_BONUS_FIX = 5;    
const BACKUP_INTERVAL_HOURS = 3;         
const BACKUP_COOLDOWN_START_HOURS = 1;   

// 5. Nama File Media 
const START_IMAGE_FILE = 'zell.jpg';
const START_AUDIO_FILE = 'corleone.mp3';
const SECONDARY_IMAGE_FILE = 'zell?.jpg'; 

// 6. Nama File Database (JSON)
const MT_FILE = 'mt_texts.json';          
const PREMIUM_FILE = 'premium_users.json'; 
const USER_DB = 'users.json';             
const HISTORY_DB = 'history.json';        
const SETTINGS_DB = 'settings.json';      
const REFERRAL_DB = 'referral.json';      
const GMAIL_DB = 'gmail_accounts.json';   

export {
  TELEGRAM_BOT_TOKEN, OWNER_ID, USERNAME_OWNER,
  VERIFICATION_GROUP_USERNAME, VERIFICATION_CHANNEL_USERNAME,
  API_URL, API_KEY, COOLDOWN_DURATION,
  COOLDOWN_TIME,
  FIX_COOLDOWN, 
  MAX_RECONNECT_ATTEMPTS,
  REFERRAL_COUNT_NEEDED, REFERRAL_BONUS_FIX,
  BACKUP_INTERVAL_HOURS, BACKUP_COOLDOWN_START_HOURS,
  START_IMAGE_FILE, START_AUDIO_FILE, SECONDARY_IMAGE_FILE,
  MT_FILE, PREMIUM_FILE, USER_DB, HISTORY_DB, SETTINGS_DB, REFERRAL_DB, GMAIL_DB
};
