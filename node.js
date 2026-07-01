const { Telegraf, Markup, session } = require('telegraf');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const canvas = require('canvas');
const path = require('path');
const axios = require('axios');
const express = require('express');
const cors = require('cors');

const TRX_DATA_FILE = 'trx_daily_data.json';
const BOT_SECRET = 'cyberbot2026';
const TRX_API_URL = 'https://trx-chart.vercel.app/api/admin/allowed-users';
const ADMIN_IDS = [1929687274];

// ========== PUBLIC API ENDPOINTS ==========
const API_ENDPOINTS = {
  RESULTS: 'https://draw.ar-lottery01.com/TrxWinGo/TrxWinGo_1M/GetHistoryIssuePage.json',
  ISSUE: 'https://api.ar-lottery01.com/api/Lottery/GetHistoryIssuePage'
};

const TRX_AUTH = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJUb2tlblR5cGUiOiJBY2Nlc3NfVG9rZW4iLCJUZW5hbnRJZCI6IjEwNzciLCJVc2VySWQiOiIxMDc3MDAwNzk3MDM1MSIsIkFnZW50Q29kZSI6IjEwNzcwMSIsIlRlbmFudEFjY291bnQiOiI3OTcwMzUxIiwiTG9naW5JUCI6IjIwMi4xOTEuMTA1Ljk1IiwiTG9naW5UaW1lIjoiLTE3NjMyMjA1NzQ2NjQiLCJTeXNDdXJyZW5jeSI6IklOUiIsIlN5c0xhbmd1YWdlIjoiZW4iLERldmljZVR5cGUiOiJBbmRyb2lkIiwiTG90dGVyeUxpbWl0R3JvdXBOdW0iOiIwIiwiVXNlclR5cGUiOiIwIiwibmJmIjoxNzYzMjIwNTc0LCJleHAiOjE3NjMzMDY5NzQsImlzcyI6Imp3dElzc3VlciIsImF1ZCI6ImxvdHRlcnlUaWNrZXQifQ.W0erDqfgCwfB-WsoR6uyoK0ZjJxebBmAd8T8G8hd9m0';

let trxDataCache = {cycleDate: "", big: 0, small: 0, lastIssue: "" };

function formatPeriod(period) {
  return period ? period.toString().slice(-5) : period;
}

const logging = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  warning: (msg) => console.log(`[WARN] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.log(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`)
};

let bypassMinBalanceUsers = new Set(); 

const BOT_TOKEN = "8209482029:AAHKgQBgO3iV5hLtQbr5PjcqhMGmyR-_WWs";
const PLATFORMS = {
  "6LOTTERY": "https://6lotteryapi.com/api/webapi/",
  "777BIGWIN": "https://api.bigwinqaz.com/api/webapi/",
  "CKLOTTERY": "https://ckygjf6r.com/api/webapi/"
};

const DEFAULT_BASE_URL = PLATFORMS["6LOTTERY"];

let sessions = {}; 
let savedUsers = []; 

// ========== ERROR HANDLER FOR BOT CONTINUITY ==========
const userErrorCounters = {};
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_RESET_TIMEOUT = 60000;

async function safeExecute(userId, operation, fallbackValue = null) {
  try {
    return await operation();
  } catch (error) {
    logging.error(`Safe execute error for user ${userId}: ${error.message}`);
    
    if (!userErrorCounters[userId]) {
      userErrorCounters[userId] = { count: 0, lastError: Date.now() };
    }
    
    userErrorCounters[userId].count++;
    userErrorCounters[userId].lastError = Date.now();
    
    if (userErrorCounters[userId].count >= MAX_CONSECUTIVE_ERRORS) {
      logging.error(`User ${userId} has ${MAX_CONSECUTIVE_ERRORS} consecutive errors!`);
      
      setTimeout(() => {
        if (userErrorCounters[userId]) {
          userErrorCounters[userId].count = 0;
          logging.info(`Error counter reset for user ${userId}`);
        }
      }, ERROR_RESET_TIMEOUT);
    }
    
    return fallbackValue;
  }
}

function resetErrorCounter(userId) {
  if (userErrorCounters[userId]) {
    userErrorCounters[userId].count = 0;
  }
}

// ========== TELEGRAM RATE LIMIT PROTECTION ==========
const telegramRateLimiter = new Map();
const TELEGRAM_RATE_LIMIT = {
  MAX_MESSAGES_PER_SECOND: 30,
  MAX_MESSAGES_PER_MINUTE: 200,
  MESSAGE_WINDOW_MS: 60000,
  BURST_LIMIT: 5,
  BURST_WINDOW_MS: 1000
};

async function sendMessageWithRateLimit(bot, chatId, text, options = {}) {
  if (!bot || !chatId) return null;
  
  return await safeExecute(chatId, async () => {
    const now = Date.now();
    const userStats = telegramRateLimiter.get(chatId) || {
      messages: [],
      lastReset: now,
      burstCount: 0
    };
    
    if (now - userStats.lastReset > TELEGRAM_RATE_LIMIT.MESSAGE_WINDOW_MS) {
      userStats.messages = [];
      userStats.burstCount = 0;
      userStats.lastReset = now;
    }
    
    userStats.messages = userStats.messages.filter(timestamp => now - timestamp < TELEGRAM_RATE_LIMIT.MESSAGE_WINDOW_MS);
    
    if (userStats.messages.length >= TELEGRAM_RATE_LIMIT.MAX_MESSAGES_PER_MINUTE) {
      const waitTime = TELEGRAM_RATE_LIMIT.MESSAGE_WINDOW_MS - (now - userStats.messages[0]);
      logging.warning(`Rate limit reached for user ${chatId}, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return sendMessageWithRateLimit(bot, chatId, text, options);
    }
    
    const recentMessages = userStats.messages.filter(ts => now - ts < TELEGRAM_RATE_LIMIT.BURST_WINDOW_MS);
    if (recentMessages.length >= TELEGRAM_RATE_LIMIT.BURST_LIMIT) {
      const waitTime = TELEGRAM_RATE_LIMIT.BURST_WINDOW_MS;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return sendMessageWithRateLimit(bot, chatId, text, options);
    }
    
    let sentMessage;
    if (options.parse_mode || options.disable_notification !== undefined || options.reply_markup) {
      sentMessage = await bot.telegram.sendMessage(chatId, text, options);
    } else {
      sentMessage = await bot.telegram.sendMessage(chatId, text);
    }
    
    userStats.messages.push(now);
    userStats.burstCount++;
    telegramRateLimiter.set(chatId, userStats);
    
    return sentMessage;
  }, null);
}

// ========== IMPROVED AUTO-LOGIN SYSTEM ==========
const loginAttemptTracker = new Map();
const LOGIN_RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY: 2000,
  MAX_DELAY: 30000,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_TIMEOUT: 300000
};

class LoginCircuitBreaker {
  constructor(userId) {
    this.userId = userId;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.isOpen = false;
  }
  
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= LOGIN_RETRY_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      this.isOpen = true;
      logging.warning(`Circuit breaker OPEN for user ${this.userId}`);
      setTimeout(() => {
        this.isOpen = false;
        this.failureCount = 0;
        logging.info(`Circuit breaker CLOSED for user ${this.userId}`);
      }, LOGIN_RETRY_CONFIG.CIRCUIT_BREAKER_TIMEOUT);
    }
  }
  
  recordSuccess() {
    this.failureCount = 0;
    this.isOpen = false;
  }
  
  canAttempt() {
    if (this.isOpen) return false;
    if (this.failureCount > 0) {
      const backoffTime = Math.min(
        LOGIN_RETRY_CONFIG.BASE_DELAY * Math.pow(2, this.failureCount - 1),
        LOGIN_RETRY_CONFIG.MAX_DELAY
      );
      if (Date.now() - this.lastFailureTime < backoffTime) {
        return false;
      }
    }
    return true;
  }
}

const loginCircuitBreakers = new Map();

function getLoginCircuitBreaker(userId) {
  if (!loginCircuitBreakers.has(userId)) {
    loginCircuitBreakers.set(userId, new LoginCircuitBreaker(userId));
  }
  return loginCircuitBreakers.get(userId);
}

// ========== SESSION BOT MAP ==========
const sessionBotMap = new Map();

// ========== AUTO-INFO BUTTON CLICK SYSTEM ==========
const autoInfoClickTracker = new Map();
const AUTO_INFO_CLICK_CONFIG = {
  CHECK_INTERVAL: 3000, 
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  COOLDOWN: 60000 
};

async function autoClickInfoButton(userId, bot) {
  if (!bot) {
    logging.error(`No bot instance for auto-click Info button for user ${userId}`);
    return false;
  }

  const now = Date.now();
  const lastClick = autoInfoClickTracker.get(userId) || 0;
  
  if (now - lastClick < AUTO_INFO_CLICK_CONFIG.COOLDOWN) {
    logging.debug(`Auto-click Info button on cooldown for user ${userId}`);
    return false;
  }

  try {
    logging.info(`🤖 Auto-clicking Info button for user ${userId} to trigger auto-login...`);
    
    const fakeCtx = {
      from: { id: userId },
      message: { text: "🏁 Info", from: { id: userId } },
      telegram: bot.telegram,
      reply: async (msg, options) => {
        try {
          await sendMessageWithRateLimit(bot, userId, msg, options);
        } catch (error) {
          logging.error(`Failed to send auto-click reply to ${userId}: ${error.message}`);
        }
      }
    };
    
    await showUserStats(fakeCtx, userId);
    
    autoInfoClickTracker.set(userId, now);
    logging.info(`✅ Auto-click Info button successful for user ${userId}`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (userSessions[userId]) {
      logging.info(`✅ User ${userId} successfully logged in via auto-click`);
      return true;
    }
    
    return false;
  } catch (error) {
    logging.error(`Auto-click Info button failed for user ${userId}: ${error.message}`);
    return false;
  }
}

// ========== IMPROVED AUTO-LOGIN WITH PLATFORM SUPPORT ==========
async function robustAutoLogin(userId, bot = null) {
  const credentials = userLoginCredentials[userId];
  
  if (!credentials || !credentials.phone || !credentials.password) {
    logging.error(`Cannot auto-login user ${userId}: Credentials not found.`);
  
    if (bot) {
      await autoClickInfoButton(userId, bot);
    }
    return false;
  }
  if (bot) {
    sessionBotMap.set(userId, bot);
  }

  const circuitBreaker = getLoginCircuitBreaker(userId);
  if (!circuitBreaker.canAttempt()) {
    logging.warning(`Login attempts blocked for user ${userId} by circuit breaker`);
 
    if (bot) {
      await autoClickInfoButton(userId, bot);
    }
    return false;
  }

  const apiUrl = credentials.apiUrl || DEFAULT_BASE_URL;
  const platformName = getPlatformDisplayName(apiUrl);

  for (let attempt = 1; attempt <= LOGIN_RETRY_CONFIG.MAX_RETRIES; attempt++) {
    try {
      logging.info(`Auto-login attempt ${attempt}/${LOGIN_RETRY_CONFIG.MAX_RETRIES} for user ${userId} on ${platformName}`);
      
      const { response: res, session } = await loginRequest(credentials.phone, credentials.password, apiUrl);

      if (session && res.code === 0) {
        
        userSessions[userId] = session;
        userSessionExpiry[userId] = Date.now() + (6 * 60 * 60 * 1000);

        const userInfo = await getUserInfo(session, userId);
        if (userInfo && userInfo.user_id) {
          userGameInfo[userId] = userInfo;
          
          if (!userStats[userId]) {
            userStats[userId] = { start_balance: parseFloat(userInfo.balance || 0), profit: 0.0 };
          } else {
            userStats[userId].start_balance = parseFloat(userInfo.balance || 0);
          }
          
          circuitBreaker.recordSuccess();
          logging.info(`✅ Auto-login successful for user ${userId} on ${platformName}`);
          logging.info(`   New token: ${session.token ? session.token.substring(0, 20) + '...' : 'No token'}`);
          
          const settings = userSettings[userId];
          if (settings && settings.running && bot) {
            try {
              await sendMessageWithRateLimit(bot, userId, 
                `🔄 Session recovered automatically!\n\n` +
                `✅ Successfully reconnected to ${platformName}\n` +
                `🤖 Bot continues running normally.`,
                { parse_mode: 'HTML', disable_notification: true }
              );
            } catch (notifyError) {
              logging.error(`Failed to notify user ${userId} about login: ${notifyError.message}`);
            }
          }
          
          return true;
        }
      }
      
      logging.warning(`Auto-login attempt ${attempt} failed for user ${userId}: ${res.msg || 'Unknown error'}`);
      
      if (attempt < LOGIN_RETRY_CONFIG.MAX_RETRIES) {
        const delay = Math.min(
          LOGIN_RETRY_CONFIG.BASE_DELAY * Math.pow(2, attempt - 1),
          LOGIN_RETRY_CONFIG.MAX_DELAY
        );
        logging.info(`Waiting ${delay}ms before retry ${attempt + 1}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
    } catch (error) {
      logging.error(`Auto-login attempt ${attempt} error for user ${userId}: ${error.message}`);
      
      if (attempt < LOGIN_RETRY_CONFIG.MAX_RETRIES) {
        const delay = Math.min(
          LOGIN_RETRY_CONFIG.BASE_DELAY * Math.pow(2, attempt - 1),
          LOGIN_RETRY_CONFIG.MAX_DELAY
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  circuitBreaker.recordFailure();
  logging.error(`❌ Auto-login failed for user ${userId} after ${LOGIN_RETRY_CONFIG.MAX_RETRIES} attempts`);
  
  if (bot) {
    logging.info(`Auto-login failed, attempting auto-click Info button for user ${userId}`);
    await autoClickInfoButton(userId, bot);
  }
  
  const settings = userSettings[userId];
  if (settings && settings.running && bot) {
    settings.running = false;
    try {
      await sendMessageWithRateLimit(bot, userId,
        `❌ Auto-login failed after ${LOGIN_RETRY_CONFIG.MAX_RETRIES} attempts!\n\n` +
        `Your bot has been stopped.\n` +
        `Please login manually using the 🔐 Login button.`,
        { parse_mode: 'HTML', disable_notification: true }
      );
    } catch (notifyError) {
      logging.error(`Failed to notify user ${userId}: ${notifyError.message}`);
    }
  }
  
  return false;
}

// ========== SESSION VALIDATION WITH 5-SECOND CHECK ==========
const sessionRecoveryQueue = new Map();
const SESSION_CHECK_INTERVAL = 5000; 

async function ensureValidSession(userId, bot = null) {
  if (userSessions[userId]) {
    const expiryTime = userSessionExpiry[userId] || 0;
    const now = Date.now();
    
    if (now < expiryTime && (expiryTime - now) > (5 * 60 * 1000)) {
      return true;
    }
    
    const lastRecovery = sessionRecoveryQueue.get(userId) || 0;
    if (now - lastRecovery < SESSION_CHECK_INTERVAL) {
      return userSessions[userId] !== null;
    }
    
    sessionRecoveryQueue.set(userId, now);
  }
  
  
  if (userLoginCredentials[userId]) {
    if (bot) {
      robustAutoLogin(userId, bot).catch(error => {
        logging.error(`Background recovery error for user ${userId}: ${error.message}`);
      });
      return userSessions[userId] !== null;
    }
    
    const loginSuccess = await robustAutoLogin(userId, null);
    return loginSuccess;
  }
  
 
  if (bot) {
    await autoClickInfoButton(userId, bot);
  }
  
  return false;
}

// ========== IMPROVED SESSION VALIDATION FOR MAIN BOT ==========
let lastSessionCheckTime = {};

async function ensureValidSessionMain(userId, bot = null) {
  const now = Date.now();
  const lastCheck = lastSessionCheckTime[userId] || 0;
  
  if (bot) {
    sessionBotMap.set(userId, bot);
  }
  
  if (now - lastCheck < SESSION_CHECK_INTERVAL && userSessions[userId]) {
    
    const expiryTime = userSessionExpiry[userId] || 0;
    if (now < expiryTime && (expiryTime - now) > (5 * 60 * 1000)) {
      return true;
    }
  }
  
  lastSessionCheckTime[userId] = now;
  
  if (!userSessions[userId]) {
    logging.info(`No session found for user ${userId}, attempting auto-login...`);
    const autoLoggedIn = await robustAutoLogin(userId, sessionBotMap.get(userId) || bot);
    if (autoLoggedIn) {
      logging.info(`✅ Auto-login successful for user ${userId} (no session)`);
      return true;
    }
    logging.warning(`❌ Auto-login failed for user ${userId} (no session)`);
    
    if (bot) {
      logging.info(`No session, attempting auto-click Info button for user ${userId}`);
      await autoClickInfoButton(userId, bot);
      if (userSessions[userId]) {
        logging.info(`✅ Auto-click Info button successful for user ${userId}`);
        return true;
      }
    }
    
    return false;
  }
  
  const expiryTime = userSessionExpiry[userId] || 0;
 
  if (now > expiryTime || (expiryTime - now) < (5 * 60 * 1000)) {
    logging.info(`Session for user ${userId} needs refresh, attempting auto-login...`);
    const refreshed = await robustAutoLogin(userId, sessionBotMap.get(userId) || bot);
    if (!refreshed) {
      logging.error(`Failed to refresh session for user ${userId}`);
      
      if (bot) {
        logging.info(`Session refresh failed, attempting auto-click Info button for user ${userId}`);
        await autoClickInfoButton(userId, bot);
        if (userSessions[userId]) {
          logging.info(`✅ Auto-click Info button successful for user ${userId}`);
          return true;
        }
      }
      
    
      const settings = userSettings[userId];
      if (settings && settings.running) {
        logging.info(`Retrying auto-login for user ${userId} after 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryRefreshed = await robustAutoLogin(userId, sessionBotMap.get(userId) || bot);
        if (retryRefreshed) {
          logging.info(`✅ Auto-login successful for user ${userId} on retry`);
          return true;
        }
      }
      return false;
    }
    logging.info(`✅ Auto-login successful for user ${userId} (refreshed)`);
    return true;
  }
  
  return true;
}

// ========== IMPROVED ALERT SYSTEM ==========
const userAlertMessages = {};
const alertCooldown = new Map();
const alertIntervals = new Map();

async function sendLossAlertWithAutoDelete(bot, userId, alertMessage, consecutiveLossCount) {
    try {
        const lastAlert = alertCooldown.get(userId) || 0;
        if (Date.now() - lastAlert < 10000) {
            logging.debug(`Alert cooldown active for user ${userId}`);
            return false;
        }
        
        if (userAlertMessages[userId]) {
            try {
                await bot.telegram.deleteMessage(userId, userAlertMessages[userId]);
                logging.info(`Deleted previous alert for user ${userId}`);
            } catch (deleteError) {
                logging.debug(`Could not delete previous alert for ${userId}: ${deleteError.message}`);
            }
        }
        
        const sentMessage = await sendMessageWithRateLimit(bot, userId, alertMessage, {
            disable_notification: false,
            disable_web_page_preview: true,
            parse_mode: 'HTML'
        });
        
        if (sentMessage) {
            userAlertMessages[userId] = sentMessage.message_id;
            alertCooldown.set(userId, Date.now());
            logging.info(`Loss alert sent to user ${userId} at ${consecutiveLossCount}x losses`);
        }
        return true;
    } catch (error) {
        logging.error(`Failed to send loss alert to ${userId}: ${error.message}`);
        return false;
    }
}

async function clearAlertForUser(bot, userId) {
    if (alertIntervals.has(userId)) {
        clearInterval(alertIntervals.get(userId));
        alertIntervals.delete(userId);
        logging.info(`Stopped alert interval for user ${userId}`);
    }
    
    if (userAlertMessages[userId]) {
        try {
            await bot.telegram.deleteMessage(userId, userAlertMessages[userId]);
            logging.info(`Cleared alert for user ${userId}`);
        } catch (deleteError) {
            logging.debug(`Could not delete alert for ${userId}: ${deleteError.message}`);
        }
        delete userAlertMessages[userId];
        alertCooldown.delete(userId);
    }
}

async function startContinuousAlertMonitor(bot) {
    logging.info("🔔 Starting Continuous Alert Monitor (10-second interval)");
    
    setInterval(async () => {
        try {
            for (const [userId, settings] of Object.entries(userSettings)) {
                const lossAlertLimit = settings?.consecutive_loss_limit;
                
                if (settings?.running && lossAlertLimit && lossAlertLimit > 0 && settings.consecutive_loss_count >= lossAlertLimit) {
                    
                    if (!alertIntervals.has(userId)) {
                     
                        const intervalId = setInterval(async () => {
                            const currentSettings = userSettings[userId];
                            if (!currentSettings || !currentSettings.running || 
                                currentSettings.consecutive_loss_count < lossAlertLimit ||
                                currentSettings.consecutive_loss_count === 0) {
                              
                                clearInterval(intervalId);
                                alertIntervals.delete(userId);
                                await clearAlertForUser(bot, userId);
                                return;
                            }
                            
                            let currentBalanceValue = null;
                            if (currentSettings.virtual_mode) {
                                if (currentSettings.admin_virtual_mode) {
                                    currentBalanceValue = userStats[userId]?.admin_virtual_balance || 0;
                                } else {
                                    currentBalanceValue = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
                                }
                            } else {
                                const session = userSessions[userId];
                                if (session) {
                                    currentBalanceValue = await safeExecute(userId, () => getBalance(session, parseInt(userId)), 0);
                                }
                            }
                            
                            const alertMessage = 
                                `⚠️⚠️ ဆက်တိုက်ဆုံးရှုံးမှုသတိပေးချက်! ⚠️⚠️\n\n` +
                                `🔴 ဆက်တိုက် ${currentSettings.consecutive_loss_count}x ကြိမ်ရှုံးနိမ့်မှု!!\n` +
                                `⚙️ သင့်ရဲ့သတိပေးချက်ကန့်သတ်ချက်: ${lossAlertLimit}x\n` +
                                `💰 လက်ရှိလက်ကျန်ငွေ: ${currentBalanceValue?.toFixed(2) || '0.00'} Ks\n\n` +
                                `💡 အကြံပြုချက်: သင့်ရဲ့ဗျူဟာကိုစစ်ဆေးပါ သို့မဟုတ် bot ကိုရပ်တန့်ပါ။\n` +
                                `🛡️ STOP ခလုတ်ကို အသုံးပြု၍ bot ကိုရပ်တန့်နိုင်သည်။`;
                            
                            await sendLossAlertWithAutoDelete(bot, userId, alertMessage, currentSettings.consecutive_loss_count);
                            
                        }, 10000);
                        
                        alertIntervals.set(userId, intervalId);
                        logging.info(`Started alert interval for user ${userId} (${lossAlertLimit}x limit)`);
                    }
                    
                 
                    settings.alert_sent_for_this_streak = true;
                    saveUserSettings();
                } else if (settings?.consecutive_loss_count === 0 && alertIntervals.has(userId)) {
                  
                    clearInterval(alertIntervals.get(userId));
                    alertIntervals.delete(userId);
                    await clearAlertForUser(bot, userId);
                }
            }
        } catch (error) {
            logging.error(`Continuous Alert Monitor error: ${error.message}`);
        }
    }, 5000); 
}

// ========== IMAGE GENERATION FUNCTIONS ==========
async function createProfitTargetImage(userId, finalBalance, profitTarget, totalProfit) {
    try {
        const imageUrl = 'https://i.ibb.co/b5340bhp/1781548214060.png';
        const response = await axios({ url: imageUrl, responseType: 'arraybuffer', timeout: 15000 });
        
        const img = new canvas.Image();
        img.src = Buffer.from(response.data, 'binary');
        const canvasObj = canvas.createCanvas(img.width, img.height);
        const ctx = canvasObj.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        ctx.textAlign = 'left'; 
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 3;
        
        const leftMargin = 70;        
        const startY = canvasObj.height * 0.25; 
        const labelToValueGap = 32;             
        const sectionGap = 95;                  
        
        const labelFont = 'bold 24px Arial';    
        const valueFont = 'bold 28px Arial';    
        
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("FINAL BALANCE", leftMargin, startY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${finalBalance} Ks`, leftMargin, startY + labelToValueGap);
        
        const targetY = startY + sectionGap;
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("PROFIT TARGET", leftMargin, targetY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${profitTarget} Ks`, leftMargin, targetY + labelToValueGap);
        
        const profitY = targetY + sectionGap;
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("TOTAL PROFIT", leftMargin, profitY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${totalProfit} Ks`, leftMargin, profitY + labelToValueGap);
        
        const fileName = `profit_target_${userId}_${Date.now()}.jpg`;
        const dir = path.join(__dirname, 'data', 'images');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, canvasObj.toBuffer('image/jpeg', { quality: 0.95 }));
        
        return { buffer: canvasObj.toBuffer('image/jpeg'), filePath, fileName };
    } catch (error) { 
        console.error("Image generation error:", error);
        return null; 
    }
}

async function createStopLossImage(userId, finalBalance, stopLoss, currentLoss) {
    try {
        const imageUrl = 'https://i.ibb.co/Wpc3h9k2/1781552925917.png';
        const response = await axios({ url: imageUrl, responseType: 'arraybuffer', timeout: 15000 });
        
        const img = new canvas.Image();
        img.src = Buffer.from(response.data, 'binary');
        const canvasObj = canvas.createCanvas(img.width, img.height);
        const ctx = canvasObj.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        ctx.textAlign = 'left'; 
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 3;
        
        const leftMargin = 90;        
        const startY = canvasObj.height * 0.25; 
        const labelToValueGap = 32;             
        const sectionGap = 95;                  
        
        const labelFont = 'bold 24px Arial';    
        const valueFont = 'bold 28px Arial';    
        
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("FINAL BALANCE", leftMargin, startY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${finalBalance} Ks`, leftMargin, startY + labelToValueGap);
        
        const targetY = startY + sectionGap;
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("STOP LOSS LIMIT", leftMargin, targetY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${stopLoss} Ks`, leftMargin, targetY + labelToValueGap);
        
        const profitY = targetY + sectionGap;
        ctx.font = labelFont; ctx.fillStyle = '#FFFF00';
        ctx.fillText("CURRENT LOSS", leftMargin, profitY);
        ctx.font = valueFont; ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${currentLoss} Ks`, leftMargin, profitY + labelToValueGap);
        
        const fileName = `stop_loss_${userId}_${Date.now()}.jpg`;
        const dir = path.join(__dirname, 'data', 'images');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, canvasObj.toBuffer('image/jpeg', { quality: 0.95 }));
        
        return { buffer: canvasObj.toBuffer('image/jpeg'), filePath, fileName };
    } catch (error) { 
        console.error("Stop Loss Image error:", error);
        return null; 
    }
}

async function createBotStoppedImage(userId, balance, profit) {
    try {
        console.log(`[DEBUG] Starting image creation for user ${userId}`);
        
        const imageUrl = 'https://i.ibb.co/zhsHQFT5/IMG-20260128-154910-226.jpg';
        console.log(`[DEBUG] Fetching image from: ${imageUrl}`);
        
        const response = await axios({ 
            url: imageUrl, 
            responseType: 'arraybuffer', 
            timeout: 15000 
        });
        
        console.log(`[DEBUG] Image fetched, size: ${response.data?.length || 0} bytes`);
        
        const img = new canvas.Image();
        
        await new Promise((resolve, reject) => {
            img.onload = () => {
                console.log(`[DEBUG] Image loaded, size: ${img.width}x${img.height}`);
                resolve();
            };
            img.onerror = (err) => {
                console.error(`[DEBUG] Image load error:`, err);
                reject(new Error("Image failed to load"));
            };
            img.src = Buffer.from(response.data, 'binary');
        });
        
        const canvasObj = canvas.createCanvas(img.width, img.height);
        const ctx = canvasObj.getContext('2d');
        
        if (!ctx) {
            throw new Error("Cannot get canvas context");
        }
        
        ctx.drawImage(img, 0, 0);
        
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        const leftMargin = 80;
        const lineSpacing = 110;
        const startY = canvasObj.height * 0.30;
        
        ctx.font = 'bold 55px "Arial", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#FFFF00';
        ctx.fillText("FINAL BALANCE", leftMargin, startY);
        
        ctx.font = 'bold 50px "Arial", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${balance} Ks`, leftMargin, startY + 70);
        
        ctx.font = 'bold 55px "Arial", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#FFFF00';
        ctx.fillText("TOTAL PROFIT", leftMargin, startY + (lineSpacing * 2));
        
        const profitNum = parseFloat(profit);
        const profitSign = profitNum > 0 ? "+" : "";
        ctx.font = 'bold 50px "Arial", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`${profitSign}${profit} Ks`, leftMargin, startY + (lineSpacing * 2) + 70);
        
        const fileName = `bot_stopped_${userId}_${Date.now()}.jpg`;
        const dir = path.join(__dirname, 'data', 'images');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, fileName);
        
        const buffer = canvasObj.toBuffer('image/jpeg', { quality: 0.95 });
        fs.writeFileSync(filePath, buffer);
        
        console.log(`[DEBUG] Image saved: ${filePath}`);
        
        return { buffer: buffer, filePath: filePath, fileName: fileName };
        
    } catch (error) {
        console.error(`[ERROR] createBotStoppedImage failed:`, error.message);
        console.error(error.stack);
        return null;
    }
}

// ========== IMAGE SENDING FUNCTIONS ==========

const profitTargetMessagesSent = new Map();

async function sendProfitTargetMessageWithImage(bot, userId, finalBalance, profitTarget, totalProfit) {
    try {
        const imageResult = await createProfitTargetImage(userId, finalBalance, profitTarget, totalProfit);
        if (imageResult && imageResult.buffer) {
            await bot.telegram.sendPhoto(userId, { source: imageResult.buffer }, {
                caption: "🎉 PROFIT TARGET MET 🎉\n\nဂုဏ်ယူပါတယ်ဗျာ။ လူကြီးမင်း သတ်မှတ်ထားတဲ့ အမြတ်ပန်းတိုင်ကို အောင်မြင်စွာ ကျော်ဖြတ်နိုင်ခဲ့ပါပြီ။",
                parse_mode: 'HTML'
            });
            setTimeout(() => {
                if (fs.existsSync(imageResult.filePath)) fs.unlinkSync(imageResult.filePath);
            }, 30000);
        } else {
            throw new Error("Image creation failed");
        }
    } catch (error) {
        await bot.telegram.sendMessage(userId, 
                      `🎉 PROFIT TARGET MET! 🎉\n\n` +
                      `💰 Final Balance: ${finalBalance} Ks\n` +
                      `🎯 Profit Target: ${profitTarget} Ks\n` +
                      `💼 Total Profit: ${totalProfit} Ks`,
        { parse_mode: 'HTML' });
    }
}

async function sendStopLossMessageWithImage(bot, userId, finalBalance, stopLoss, currentLoss) {
    try {
        const imageResult = await createStopLossImage(userId, finalBalance, stopLoss, currentLoss);
        if (imageResult && imageResult.buffer) {
            await bot.telegram.sendPhoto(userId, { source: imageResult.buffer }, {
                caption: "🚫 STOP LOSS LIMIT REACHED! 🚫\n\nလူကြီးမင်း သတ်မှတ်ထားတဲ့ အရှုံး Area ထဲ ရောက်သွားတဲ့အတွက် စနစ်အရ အရောင်းအဝယ်ကို ခေတ္တရပ်ဆိုင်းထားပါတယ်။\nစိတ်အေးအေးထားပြီး နောက်တစ်ကြိမ်မှာ အစီအစဉ်တကျ ပြန်လည်ပြင်ဆင်လိုက်ပါ။ အားတင်းထားပါဗျာ! 📈🚀",
                parse_mode: 'HTML'
            });
            setTimeout(() => {
                if (fs.existsSync(imageResult.filePath)) fs.unlinkSync(imageResult.filePath);
            }, 30000);
        } else {
            throw new Error("Image creation failed");
        }
    } catch (error) {
        await bot.telegram.sendMessage(userId, 
            `🚫 STOP LOSS LIMIT REACHED! 🚫\n\n` +
            `🚑 Stop Loss Limit: ${stopLoss} Ks\n` +
            `♦ Current Loss: ${currentLoss} Ks\n` +
            `💰 Final Balance: ${finalBalance} Ks`,
            { parse_mode: 'HTML' }
        );
    }
}

async function sendBotStoppedMessageWithImage(telegram, userId, balance, profit) {
    try {
        const imageResult = await createBotStoppedImage(userId, balance, profit);
        if (imageResult && imageResult.buffer) {
            await telegram.sendPhoto(userId, { source: imageResult.buffer }, {
                caption: "🚫 BOT STOPPED (Manual)",
                parse_mode: 'HTML'
            });
            setTimeout(() => {
                if (fs.existsSync(imageResult.filePath)) fs.unlinkSync(imageResult.filePath);
            }, 30000);
        } else {
            throw new Error("Image creation failed");
        }
    } catch (error) {
       
        await telegram.sendMessage(userId, 
            `🚫 BOT STOPPED (Manual)\n\n` +
            `💰 Final Balance: ${balance} Ks\n` +
            `💰 Total Profit: ${profit} Ks`,
            { parse_mode: 'HTML' }
        );
    }
}

function checkLoseSLSkip(userId, settings) {
  const loseSLValue = settings.lose_sl;
  
  if (!loseSLValue || loseSLValue === 0) {
    return { shouldSkip: false, reason: "", skipCount: 0, currentSkip: 0 };
  }
  
  if (settings.lose_sl_active && settings.lose_sl_skip_count > 0) {
    const currentSkip = settings.lose_sl_skipped_count + 1;
    const skipCount = settings.lose_sl_skip_count;
    
    return {
      shouldSkip: true,
      reason: `💀 Lose SL ${loseSLValue} - Skip`,
      skipCount: skipCount,
      currentSkip: currentSkip
    };
  }
  
  return { shouldSkip: false, reason: "", skipCount: 0, currentSkip: 0 };
}

// === AUTO-SYNC-WEBSITE ===
async function verifyAndSyncWebsite() {
  try {
    const response = await fetch(`${TRX_API_URL}?secret=${BOT_SECRET}`);
    const result = await response.json();
    
    const websiteIds = new Set(result.allowed_ids || []);
    const localIds = Array.from(allowed777bigwinIds);
    
    const missingUsers = localIds.filter(id => !websiteIds.has(id));
    
    if (missingUsers.length > 0) {
      console.log(`[SYNC] ${missingUsers.length} users missing from website, re-syncing...`);
      
      for (const userId of missingUsers) {
        await fetch(TRX_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', user_id: userId, secret: BOT_SECRET })
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      console.log('[SYNC] Re-sync complete');
    }
  } catch (error) {
    console.error('[SYNC] Error:', error.message);
  }
}

async function syncUserToBoth(userId, action) {
  try {
    if (action === 'add') {
      allowed777bigwinIds.add(userId);
      saveAllowedUsers();
    } else if (action === 'remove') {
      allowed777bigwinIds.delete(userId);
      saveAllowedUsers();
    }

    const response = await fetch(TRX_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: action,
        user_id: userId,
        secret: BOT_SECRET
      })
    });
    
    return await response.json();
  } catch (error) {
    console.error(`Error syncing user ${userId} to TRX API:`, error.message);
    return { success: false, error: error.message };
  }
}

// ========== ADMIN HANDLER FUNCTIONS ==========
async function handleAddBypass(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return await ctx.reply('❌ Admin only.');

  const rawText = ctx.message.text;
  
  if (rawText === "➕ Add Bypass") {
    userTemp[userId] = { state: "ADMIN_ADD_BYPASS", step: 0 };
    await ctx.reply("➕ ADD MINIMUM BALANCE BYPASS USER\n\nEnter User ID to allow bypassing 30,000 minimum balance requirement:", 
      Markup.keyboard([["❌ Cancel"]])
    );
    return;
  }
  const args = ctx.message.text.split(' ');
  const targetId = args[1];

  if (!targetId) {
    return await ctx.reply("❌ Usage: /addbypass <id>");
  }

  if (isNaN(targetId)) {
    return await ctx.reply('❌ Invalid ID.');
  }

  bypassMinBalanceUsers.add(parseInt(targetId));
  saveBypassUsers();
  await ctx.reply(`✅ Added ${targetId} to bypass list. This user can now play with less than 30,000 Ks balance.`);
}

async function handleRemoveBypass(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return await ctx.reply('❌ Admin only.');

  const rawText = ctx.message.text;
  
  if (rawText === "❌ Remove Bypass") {
    userTemp[userId] = { state: "ADMIN_REMOVE_BYPASS", step: 0 };
    await ctx.reply("❌ REMOVE MINIMUM BALANCE BYPASS USER\n\nEnter User ID to remove from bypass list:", 
      Markup.keyboard([["❌ Cancel"]])
    );
    return;
  }
  
  const args = ctx.message.text.split(' ');
  const targetId = args[1];

  if (!targetId) {
    return await ctx.reply("❌ Usage: /removebypass <id>");
  }

  if (isNaN(targetId)) {
    return await ctx.reply('❌ Invalid ID.');
  }

  if (bypassMinBalanceUsers.has(parseInt(targetId))) {
    bypassMinBalanceUsers.delete(parseInt(targetId));
    saveBypassUsers();
    await ctx.reply(`✅ Removed ${targetId} from bypass list. User now requires 30,000 Ks minimum balance.`);
  } else {
    await ctx.reply(`❌ User ${targetId} not found in bypass list.`);
  }
}

async function handleAddUser(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return await ctx.reply('❌ Admin only.');

  const rawText = ctx.message.text;
  
  if (rawText === "➕ Add User") {
    userTemp[userId] = { state: "ADMIN_ADD_USER", step: 0 };
    await ctx.reply("➕ ADD USER (BOTH SYSTEMS)\n\nEnter User ID:", 
      Markup.keyboard([["❌ Cancel"]])
    );
    return;
  }

  const args = ctx.message.text.split(' ');
  const targetId = args[1]; 

  if (!targetId) {
    return await ctx.reply("❌ Usage: /add <id>");
  }

  if (isNaN(targetId)) {
    return await ctx.reply('❌ Invalid ID.');
  }
  
  const result = await syncUserToBoth(parseInt(targetId), 'add');
  if (result.success) {
    await ctx.reply(`✅ Added ${targetId} to Both Systems.`);
  } else {
    await ctx.reply(`⚠️ Added locally, but API Error: ${result.error}`);
  }
}

async function handleRemoveUser(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return await ctx.reply('❌ Admin only.');

  const rawText = ctx.message.text;
  
  if (rawText === "❌ Remove User") {
    userTemp[userId] = { state: "ADMIN_REMOVE_USER", step: 0 };
    await ctx.reply("❌ REMOVE USER (BOTH SYSTEMS)\n\nEnter User ID:", 
      Markup.keyboard([["❌ Cancel"]])
    );
    return;
  }
  
  const args = ctx.message.text.split(' ');
  const targetId = args[1];

  if (!targetId) {
    return await ctx.reply("❌ Usage: /remove <id>");
  }

  if (isNaN(targetId)) {
    return await ctx.reply('❌ Invalid ID.');
  }

  const result = await syncUserToBoth(parseInt(targetId), 'remove');
  if (result.success) {
    await ctx.reply(`✅ Removed ${targetId} from Both Systems.`);
  } else {
    await ctx.reply(`⚠️ Removed locally, but API Error: ${result.error}`);
  }
}

async function handleAddChannel(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;
  
  const text = ctx.message.text;
  const regex = /\/addchannel\s+([-\w]+)\s+"([^"]+)"\s+(\d+)/;
  const match = text.match(regex);

  if (!match) {
    return ctx.reply('Usage: /addchannel ID "Name" Confidence\nEx: /addchannel -100123456 "AlinKar-Signal" 65');
  }

  if (savedChannels.length >= 10) {
    return ctx.reply('❌ Max 10 channels allowed in menu strategy!');
  }

  const newChannel = {
    id: match[1],
    name: match[2],
    reliability: parseInt(match[3])
  };

  const exists = savedChannels.find(ch => ch.id === newChannel.id);
  if (exists) {
    return ctx.reply('⚠️ Channel ID already exists. Remove it first.');
  }

  savedChannels.push(newChannel);
  saveSavedChannels();
  ctx.reply(`✅ Added Channel:\nName: ${newChannel.name}\nID: ${newChannel.id}\nConf: ${newChannel.reliability}%`);
}

async function handleRemoveChannel(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;

  const args = ctx.message.text.split(' ');
  const targetId = args[1];

  if (!targetId) return ctx.reply('Usage: /removechannel <ChannelID>');

  const initialLength = savedChannels.length;
  savedChannels = savedChannels.filter(ch => ch.id !== targetId);
  saveSavedChannels();

  if (savedChannels.length < initialLength) {
    ctx.reply(`✅ Channel ${targetId} removed.`);
  } else {
    ctx.reply(`❌ Channel ID not found.`);
  }
}

async function handleBroadcast(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;

  const messageText = ctx.message.text.substring(10).trim();
  if (!messageText) {
    await ctx.reply("❌ Usage: /broadcast <message>");
    return;
  }

  const fullMessage = `📢 ADMIN MESSAGE:\n\n${messageText}`;

  let successCount = 0;
  let failCount = 0;

  const uniqueUsers = new Set();
  allUsers.forEach(id => uniqueUsers.add(parseInt(id)));
  Object.keys(userSessions).forEach(id => uniqueUsers.add(parseInt(id)));

  for (const userIdStr of uniqueUsers) {
    try {
      await sendMessageWithRateLimit(ctx.telegram, userIdStr, fullMessage);
      successCount++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      failCount++;
    }
  }

  await ctx.reply(`✅ Broadcast sent to ${successCount} users (Failed: ${failCount})`);
}

async function handleShowAll(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return await ctx.reply('❌ Admin only.');

  try {
    const localIds = Array.from(allowed777bigwinIds);

    const apiResponse = await fetch(`${TRX_API_URL}?secret=${BOT_SECRET}`);
    const apiData = await apiResponse.json();
    const apiIds = apiData.success ? apiData.allowed_ids : [];

    const combinedIds = [...new Set([...localIds, ...apiIds])];

    if (combinedIds.length === 0) {
      return ctx.reply('📋 No users found in either system.');
    }

    let message = `📋 COMBINED USER LIST\n`;
    message += `📂 BOT: ${localIds.length} | 🌐 WEBSITE: ${apiIds.length}\n`;
    message += `━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n`;
    
    combinedIds.forEach((id, i) => {
      const isLocal = localIds.includes(id) ? '📂' : ' ';
      const isApi = apiIds.includes(id) ? '🌐' : ' ';
      message += `${i + 1}. \`${id}\`  ${isLocal}${isApi}\n`;
    });
    
    message += `\n📊 Total Unique Users: ${combinedIds.length}`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Error fetching user lists.');
  }
}

async function handleUserStats(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;
  
  try {
    const totalUsers = allUsers.size;
    const loggedInUsers = Object.keys(userSessions).length;
    const notLoggedInUsers = totalUsers - loggedInUsers;
    const activeBots = Object.values(userSettings).filter(s => s.running).length;
    const savedChannelsCount = savedChannels.length;
    const activeSignals = Object.keys(channelSignals).length;
    
    let runningBotsInfo = "";
    const runningBots = Object.entries(userSettings).filter(([id, settings]) => settings.running);
    if (runningBots.length > 0) {
      runningBotsInfo = "\n\n🤖 RUNNING BOTS:\n";
      runningBots.slice(0, 10).forEach(([id, settings]) => {
        const strategy = settings.strategy || "N/A";
        runningBotsInfo += `• User ${id}: ${strategy}\n`;
      });
      if (runningBots.length > 10) {
        runningBotsInfo += `... and ${runningBots.length - 10} more\n`;
      }
    }
    
    const message = 
      `📊 SYSTEM STATISTICS\n\n` +
      `👥 Total Registered Users: ${totalUsers}\n` +
      `✅ Currently Logged In: ${loggedInUsers}\n` +
      `❌ Not Logged In: ${notLoggedInUsers}\n` +
      `🤖 Active Bots: ${activeBots}\n\n` +
      `📡 Channel Statistics:\n` +
      `   Saved Channels: ${savedChannelsCount}\n` +
      `   Active Signals: ${activeSignals}\n` +
      `${runningBotsInfo}`;
    
    await ctx.reply(message);
  } catch (error) {
    logging.error(`Error in handleUserStats: ${error.message}`);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleSignalStatus(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;
  
  try {
    if (savedChannels.length === 0) {
      await ctx.reply("📡 No channels have been added yet.\nUse /addchannel to add a signal source.");
      return;
    }

    let message = `📡 CHANNEL SIGNAL STATUS\n\n`;
    
    savedChannels.forEach(ch => {
      const signal = channelSignals[ch.id];
      let status = "🔴 NO SIGNAL";
      let details = "";
      
      if (signal) {
        const signalAge = Date.now() - signal.receivedAt;
        if (signalAge > CHANNEL_SIGNAL_EXPIRY_TIME) {
          status = "🔴 EXPIRED";
        } else {
          status = "🟢 ACTIVE";
        }
        const period = signal.fullPeriod || signal.period || "N/A";
        details = `\n  Period: ${period}\n  Prediction: ${signal.prediction === 'B' ? 'BIG' : 'SMALL'}\n  Age: ${Math.floor(signalAge / 1000)}s`;
      }
      
      message += `📌 ${ch.name} (ID: ${ch.id})\n  Status: ${status}${details}\n\n`;
    });
    
    const activeSignals = Object.values(channelSignals).filter(signal => {
      const signalAge = Date.now() - signal.receivedAt;
      return signalAge <= CHANNEL_SIGNAL_EXPIRY_TIME;
    }).length;
    
    message += `📊 Summary: ${activeSignals} active signals out of ${savedChannels.length} channels`;
    
    await ctx.reply(message);
  } catch (error) {
    logging.error(`Error in handleSignalStatus: ${error.message}`);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleAdminVirtualBalance(ctx) {
  const userId = ctx.from.id;
  if (!ADMIN_IDS.includes(userId)) return;

  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply("❌ Usage: /adminbalance <amount>\nExample: /adminbalance 1000000");
  }

  if (!userStats[userId]) {
    userStats[userId] = { admin_virtual_balance: amount, admin_start_balance: amount, profit: 0.0 };
  } else {
    userStats[userId].admin_virtual_balance = amount;
    userStats[userId].admin_start_balance = amount;
    userStats[userId].profit = 0.0;
  }

  userSettings[userId].virtual_mode = true;
  userSettings[userId].admin_virtual_mode = true;
  
  saveUserSettings();

  await ctx.reply(`✅ Admin Virtual Balance Set!\n\n💰 Balance: ${amount.toLocaleString()} Ks\n📊 Mode: ADMIN Virtual`);
}

// ========== CORE FUNCTIONS ==========

async function checkProfitAndStopLoss(userId, bot) {
    const settings = userSettings[userId] || {};
    const targetProfit = settings.target_profit;
    const stopLoss = settings.stop_loss;
    
    if (!targetProfit && !stopLoss) {
        return false;
    }
    
    let currentProfit;
    let finalBalance;
    let modeText = "Real";
    
    if (settings.virtual_mode) {
        modeText = "Virtual";
        if (settings.admin_virtual_mode) {
            currentProfit = (userStats[userId]?.admin_virtual_balance || 0) - (userStats[userId]?.admin_start_balance || 0);
            finalBalance = userStats[userId]?.admin_virtual_balance || 0;
        } else {
            currentProfit = (userStats[userId]?.virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE;
            finalBalance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
        }
    } else {
        currentProfit = userStats[userId]?.profit || 0;
        const session = userSessions[userId];
        const balance = await safeExecute(userId, () => getBalance(session, userId), 0);
        finalBalance = balance || 0;
    }
    
    let profitIndicator = "";
    if (currentProfit > 0) {
        profitIndicator = "+";
    } else if (currentProfit < 0) {
        profitIndicator = "-";
    } else {
        profitIndicator = "";
    }
    
    if (targetProfit && currentProfit >= targetProfit) {
        logging.info(`User ${userId} - Profit target reached: ${currentProfit} >= ${targetProfit}`);
        
        settings.running = false;
        
        delete userWaitingForResult[userId];
        delete userShouldSkipNext[userId];
        
        await sendProfitTargetMessageWithImage(bot, userId, finalBalance.toFixed(2), targetProfit, profitIndicator + Math.abs(currentProfit).toFixed(2), modeText);
        return true;
    }
    
    if (stopLoss && currentProfit <= -stopLoss) {
        settings.running = false;
        
        delete userWaitingForResult[userId];
        delete userShouldSkipNext[userId];
        
        await sendStopLossMessageWithImage(bot, userId, finalBalance.toFixed(2), stopLoss, Math.abs(currentProfit).toFixed(2), modeText);
        return true;
    }
    
    return false;
}

function resetUserState(userId) {
    profitTargetMessagesSent.delete(userId);
}

// ========== SESSION MANAGEMENT ==========

function getSession(ctxOrUserId) {
    const userId = typeof ctxOrUserId === 'object' ? ctxOrUserId.from.id : ctxOrUserId;
    if (!sessions[userId]) {
        sessions[userId] = {
            id: userId,
            isLoggedIn: false,
            platform: DEFAULT_BASE_URL,
            username: '',
            token: '',
            betAmount: 0,
            betType: '',
            lastBetPeriodId: null,
            account: '',
            password: '',
        };
    }
    return sessions[userId];
}

// ========== API REQUESTS - FIXED WITH SESSION UPDATE ==========

async function enhancedPostRequest(session, endpoint, data, userId) {
    const url = session.platform + endpoint;
    
    const executeRequest = async (currentToken) => {
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Mobile Build/QP1A.190711.020)',
                'Connection': 'Keep-Alive',
                'Authorization': currentToken ? `Bearer ${currentToken}` : '',
                'Ar-Origin': 'https://6win598.com',
                'Origin': 'https://6win598.com',
                'Referer': 'https://6win598.com/',
            },
            body: JSON.stringify(data)
        };

        return new Promise((resolve, reject) => {
            const agent = new https.Agent({ rejectUnauthorized: false });
            const req = https.request(url, { ...options, agent }, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(responseData);
                        resolve({ status: res.statusCode, data: jsonData });
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${error.message}`));
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
            
            req.setTimeout(15000);
            req.write(JSON.stringify(data));
            req.end();
        });
    };

    try {
        let result = await executeRequest(session.token);

        const isUnauthorized = result.status === 401 || 
                              (result.data && (result.data.code === 1004 || 
                               (result.data.msg && result.data.msg.includes("Login failure"))));

        if (isUnauthorized) {
            logging.warning(`User ${userId} - API call to ${endpoint} returned Unauthorized. Attempting Auto-Login...`);
            
            const bot = sessionBotMap.get(userId) || null;
            const loginSuccess = await robustAutoLogin(userId, bot);
            
            if (loginSuccess) {
                logging.info(`User ${userId} - Auto-Login successful. Retrying original request to ${endpoint}.`);
                
                
                const updatedSession = userSessions[userId];
                if (!updatedSession) {
                    logging.error(`User ${userId} - Session not found after auto-login`);
                    return { code: -1, msg: "Session not found after auto-login" };
                }
                
             
                session.token = updatedSession.token;
                session.platform = updatedSession.platform;
                
               
                userSessions[userId] = session;
                
                logging.info(`User ${userId} - Session updated with new token: ${session.token ? session.token.substring(0, 20) + '...' : 'No token'}`);
                
               
                result = await executeRequest(session.token);
                return result.data;
            } else {
                logging.error(`User ${userId} - Auto-Login failed. Cannot proceed with API call.`);
                session.isLoggedIn = false;
                return { code: -1, msg: "Auto-Login failed. Please login again." };
            }
        }
        
        return result.data;
    } catch (error) {
        logging.error(`Request failed for user ${userId}: ${error.message}`);
        return { code: -1, msg: error.message };
    }
}

async function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const agent = new https.Agent({ 
            rejectUnauthorized: false,
            keepAlive: true,
            keepAliveMsecs: 1000
        });
        
        const defaultOptions = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Mobile Build/QP1A.190711.020)',
                'Connection': 'Keep-Alive',
                'Ar-Origin': 'https://6win598.com',
                'Origin': 'https://6win598.com',
                'Referer': 'https://6win598.com/',
            },
            timeout: 12000
        };
        
        const requestOptions = {
            ...defaultOptions,
            ...options,
            agent
        };
        
        const req = https.request(url, requestOptions, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ data: jsonData });
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        
        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        
        req.end();
    });
}

function generateSignature(data) {
    const f = {};
    const exclude = ["signature", "track", "xosoBettingData"];
    
    Object.keys(data).sort().forEach(function(k) {
        const v = data[k];
        if (v !== null && v !== '' && !exclude.includes(k)) {
            f[k] = v === 0 ? 0 : v;
        }
    });
    
    const jstr = JSON.stringify(f);
    return crypto.createHash('md5').update(jstr).digest('hex').toUpperCase();
}

function signMd5Original(data) {
    const dataCopy = { ...data };
    delete dataCopy.signature;
    delete dataCopy.timestamp;
    const sorted = Object.keys(dataCopy).sort().reduce((acc, key) => {
        acc[key] = dataCopy[key];
        return acc;
    }, {});
    const jsonStr = JSON.stringify(sorted).replace(/\s+/g, '');
    return crypto.createHash('md5').update(jsonStr).digest('hex').toUpperCase();
}

// ========== USER MANAGEMENT ==========

const WIN_LOSE_CHECK_INTERVAL = 1;
const MAX_RESULT_WAIT_TIME = 60;
const ADMIN_ID = 1929687274;
const MAX_BALANCE_RETRIES = 10;
const BALANCE_RETRY_DELAY = 5;
const BALANCE_API_TIMEOUT = 20000;
const BET_API_TIMEOUT = 30000;
const MAX_BET_RETRIES = 3;
const BET_RETRY_DELAY = 5;
const MAX_CONSECUTIVE_ERRORS_BET = 5;
const MESSAGE_RATE_LIMIT_SECONDS = 10;
const MAX_TELEGRAM_RETRIES = 3;
const TELEGRAM_RETRY_DELAY = 2000;
const DEFAULT_BS_ORDER = "BSBBSBSSSB";
const VIRTUAL_BALANCE = 1000000;
const CHANNEL_SIGNAL_WAIT_TIME = 30000; 
const CHANNEL_SIGNAL_EXPIRY_TIME = 120000;
const CHANNEL_MONITOR_INTERVAL = 1000; 
const DELAY_AFTER_RESULT = 5000;
const MYANMAR_TIME_OFFSET = 6.5 * 60 * 60 * 1000;
const MINIMUM_BALANCE_REQUIRED = 30000;

let userBreakerHistory = {};
let dreamPatterns = {};
let channelSignals = {}; 
let savedChannels = []; 
let channelMonitorRunning = false;
let lastChannelSignalCheck = {};
let channelSignalMonitorInterval = null;

function loadSavedChannels() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'saved_channels.json');
    if (fs.existsSync(filePath)) {
      savedChannels = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      logging.info(`Loaded ${savedChannels.length} saved channels.`);
    }
  } catch (error) {
    logging.error(`Error loading saved channels: ${error.message}`);
  }
}

function loadDreamPatterns() {
  try {
    if (fs.existsSync('dream.json')) {
      const data = JSON.parse(fs.readFileSync('dream.json', 'utf8'));
      dreamPatterns = data;
      logging.info(`Loaded ${Object.keys(dreamPatterns).length} patterns for DREAM strategy`);
    } else {
      logging.warning("dream.json not found. Using default DREAM patterns.");
      dreamPatterns = {
        "0": "SBBSBSSBBS",
        "1": "BBSBSBSBBS",
        "2": "SBSBBSBSBB",
        "3": "BSBSBSSBSB",
        "4": "SBBSBSBBSS",
        "5": "BSSBSBBSBS",
        "6": "BSBSSBSBSB",
        "7": "SBSBSBSSBB",
        "8": "BSBBSBSBSB",
        "9": "SBSBBSSBSB"
      };
    }
  } catch (error) {
    logging.error(`Error loading dream.json: ${error.message}`);
    dreamPatterns = {
      "0": "SBBSBSSBBS",
      "1": "BBSBSBSBBS",
      "2": "SBSBBSBSBB",
      "3": "BSBSBSSBSB",
      "4": "SBBSBSBBSS",
      "5": "BSSBSBBSBS",
      "6": "BSBSSBSBSB",
      "7": "SBSBSBSSBB",
      "8": "BSBBSBSBSB",
      "9": "SBSBBSSBSB"
    };
  }
}

function saveSavedChannels() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'saved_channels.json');
    fs.writeFileSync(filePath, JSON.stringify(savedChannels, null, 4));
  } catch (error) {
    logging.error(`Error saving channels: ${error.message}`);
  }
}

const channelSources = new Map(); 

const CHATGPT_PATTERNS = {
  "BBBS": "S",
  "SBBB": "B",
  "SSBB": "S",
  "BBSS": "S",
  "BSSS": "B",
  "SSSB": "S",
  "BSBB": "B",
  "SBSS": "B",
  "SSBS": "B",
  "BBSB": "S",
  "SBBS": "S",
  "BSSB": "B",
  "BSBS": "S",
  "SBSB": "B"
};

const COLORS = {
  GREEN: { name: 'Green', id: 11, numbers: [1, 3, 7, 9] },
  VIOLET: { name: 'Violet', id: 12, numbers: [0, 5] },
  RED: { name: 'Red', id: 10, numbers: [2, 4, 6, 8] }
};

const GAME_TYPES = {
  TRX: { typeId: 13, language: 7, endpoint: "GetTrxGameIssue", betEndpoint: "GameTrxBetting", random: "b559fbe5f9c8402190a1d2d8de97ce50" },
  WINGO30S: { typeId: 30, language: 7, endpoint: "GetGameIssue", betEndpoint: "GameBetting", random: "616fb37000504db2beab210b50c74498" }
};

const COLOR_MAPPING = {
  "0": "V",
  "1": "G",
  "2": "R",
  "3": "G",
  "4": "R",
  "5": "V",
  "6": "R",
  "7": "G",
  "8": "R",
  "9": "G"
};

const userState = {};
const userTemp = {};
const userSessions = {};
const userSettings = {};
const userPendingBets = {};
const userWaitingForResult = {};
const userStats = {};
const userGameInfo = {};
const userSkippedBets = {};
const userShouldSkipNext = {};
const userBalanceWarnings = {};
const userSkipResultWait = {};
const userStopInitiated = {};
const userSLSkipWaitingForWin = {};
const userResultHistory = {};
const userCommandLocks = {};
const userLastNumbers = [];
const userAllResults = {};
const userSessionExpiry = {};
const userPeriodCounters = {};
const userLoginCredentials = {};
const userDelayUntil = {}; 
const userLoseSLSkip = {};

let allowed777bigwinIds = new Set([
  286994, 929793, 816396, 540349, 1017791
]);
    
let allUsers = new Set();

const userManualBetHistory = {};
let userManualState = {};
let userResultsMessages = {};
let userLastResults = {};

// ========== BS ORDER FIXED PREDICTION FUNCTION ==========

async function getBSOrderPrediction(userId, gameType = "TRX") {
  try {
    const settings = userSettings[userId] || {};
    
    if (!settings.pattern) {
      settings.pattern = DEFAULT_BS_ORDER;
      settings.pattern_index = 0;
      logging.info(`BS Order: No pattern provided, using default: ${DEFAULT_BS_ORDER}`);
      saveUserSettings();
    }
    
    const pattern = settings.pattern;
    const patternIndex = settings.pattern_index || 0;
    
    const currentIndex = patternIndex % pattern.length;
    const prediction = pattern[currentIndex];
    
    logging.info(`BS Order: Pattern: ${pattern}, Index: ${currentIndex}/${pattern.length}, Prediction: ${prediction}`);
    
    settings.pattern_index = (currentIndex + 1) % pattern.length;
    saveUserSettings();
    
    return { result: prediction, percent: "N/A", shouldSkip: false };
  } catch (error) {
    logging.error(`Error getting BS Order prediction: ${error.message}`);
    const randomPrediction = Math.random() < 0.5 ? 'B' : 'S';
    return { result: randomPrediction, percent: "50.0", shouldSkip: false };
  }
}

// ========== CHANNEL SIGNAL FUNCTIONS ==========

async function startChannelSignalMonitor(bot) {
  if (channelMonitorRunning) return;
  
  channelMonitorRunning = true;
  logging.info('📡 Starting Channel Signal Monitor (1-second interval)');
  
  channelSignalMonitorInterval = setInterval(async () => {
    try {
      await monitorChannelSignals(bot);
    } catch (error) {
      logging.error(`Channel monitor error: ${error.message}`);
    }
  }, CHANNEL_MONITOR_INTERVAL);
}

async function monitorChannelSignals(bot) {
  try {
    const now = Date.now();
    
    for (const channelId in channelSignals) {
      const signal = channelSignals[channelId];
      if (signal) {
        const signalAge = now - signal.receivedAt;
        
        if (signalAge > CHANNEL_SIGNAL_EXPIRY_TIME) {
          delete channelSignals[channelId];
          logging.debug(`Signal expired for channel ${channelId}`);
        }
      }
    }
    
    if (Math.floor(now / 1000) % 30 === 0) {
      const activeSignals = Object.keys(channelSignals).length;
      logging.info(`📡 Channel Monitor - Active signals: ${activeSignals}, Total channels: ${savedChannels.length}`);
    }
    
  } catch (error) {
    logging.error(`Error in channel signal monitor: ${error.message}`);
  }
}

async function enhancedChannelPostHandler(ctx, bot) {
  try {
    const message = ctx.channelPost || ctx.message;
    if (!message || !message.text) return;

    const rawText = message.text;
    const sourceChannelId = ctx.chat ? ctx.chat.id.toString() : null; 
    
    logging.debug(`Received message from channel ID: ${sourceChannelId} - ${rawText.substring(0, 50)}...`);
    
    const isTrackedChannel = savedChannels.find(ch => ch.id.toString() === sourceChannelId);
    
    if (isTrackedChannel) {
      const signal = parseChannelSignal(rawText, sourceChannelId);
      
      if (signal.valid) {
        const signalPeriodShort = signal.fullPeriod ? signal.fullPeriod.slice(-5) : signal.period;
        
        channelSignals[sourceChannelId] = {
          ...signal,
          period: signalPeriodShort, 
          fullPeriod: signal.fullPeriod,
          name: isTrackedChannel.name, 
          confidence: isTrackedChannel.reliability,
          receivedAt: Date.now()
        };
        
        logging.info(`✅ Signal Received from ${isTrackedChannel.name}: Period: ${signalPeriodShort} -> ${signal.prediction}`);
        
      }
    }
  } catch (error) {
    logging.error(`Error in channel post handler: ${error.message}`);
  }
}

function loadUserCredentials() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'user_credentials.json');
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      Object.assign(userLoginCredentials, data);
      logging.info(`Loaded credentials for ${Object.keys(data).length} users`);
    }
  } catch (error) {
    logging.error(`Error loading credentials: ${error.message}`);
  }
}

function saveUserCredentials() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'user_credentials.json');
    
    fs.writeFileSync(filePath, JSON.stringify(userLoginCredentials, null, 4));
    logging.info(`Saved credentials for ${Object.keys(userLoginCredentials).length} users`);
  } catch (error) {
    logging.error(`Error saving credentials: ${error.message}`);
  }
}

async function restoreSessions() {
  logging.info("♻️ Restoring sessions for saved users...");
  const userIds = Object.keys(userLoginCredentials);
  
  for (const userId of userIds) {
    const creds = userLoginCredentials[userId];
    if (creds && creds.phone && creds.password) {
      try {
        const apiUrl = creds.apiUrl || DEFAULT_BASE_URL;
        logging.info(`Auto-logging in user ${userId} to ${apiUrl}...`);
        
        const { response: res, session } = await loginRequest(creds.phone, creds.password, apiUrl);
        
        if (session) {
            userSessions[userId] = session;
            userSessionExpiry[userId] = Date.now() + (6 * 60 * 60 * 1000);
            
            const userInfo = await getUserInfo(session, userId);
            if (userInfo) {
                userGameInfo[userId] = userInfo;
                logging.info(`✅ Auto-login successful for user ${userId}`);
            }
        } else {
            logging.warning(`❌ Auto-login failed for user ${userId}: ${res.msg}`);
        }
      } catch (error) {
        logging.error(`Error during auto-login for ${userId}: ${error.message}`);
      }
   
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  logging.info("♻️ Session restoration complete.");
}

async function autoLoginUserForMainBot(userId, bot = null) {
  return await robustAutoLogin(userId, bot);
}

function parseChannelSignal(text, sourceChannel = null) {
  try {
    const normalizedText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const flatText = normalizedText.replace(/\s+/g, ' ').trim();

    const normalizePrediction = (value) => {
      if (!value) return null;

      let prediction = value.toUpperCase().trim();

      if (prediction === "ကြီး") prediction = "BIG";
      if (prediction === "ငယ်") prediction = "SMALL";
      if (prediction === "🔵🔵🔵" || prediction === "🟦🟦🟦") prediction = "BIG";
      if (prediction === "🔴🔴🔴" || prediction === "🟥🟥🟥") prediction = "SMALL";
      if (prediction === "BIG") prediction = "B";
      if (prediction === "SMALL") prediction = "S";

      return prediction === "B" || prediction === "S" ? prediction : null;
    };

    const buildResult = (period, prediction, confidence) => {
      const normalizedPrediction = normalizePrediction(prediction);
      if (!period || !normalizedPrediction) return null;

      return {
        period: period.slice(-5),
        fullPeriod: period,
        prediction: normalizedPrediction,
        receivedAt: Date.now(),
        valid: true,
        confidence,
        source: sourceChannel
      };
    };

    const getConfidence = (mode = "generic") => {
      if (sourceChannel && channelSources.has(sourceChannel)) {
        return channelSources.get(sourceChannel).reliability || 70;
      }

      if (mode === "high_context") return 95;
      if (mode === "medium_context") return 85;
      if (mode === "generic_pair") return 75;
      return 60;
    };

    const findPeriod = () => {
      const highContextPatterns = [
        /(?:MATCH|PERIOD|ISSUE|ROUND|ID|🆔|NO|NUMBER)\s*[:#=：-]?\s*(\d{5,})/i,
        /⏰\s*(\d{5,})/,
        /#\s*(\d{5,})\b/
      ];

      for (const pattern of highContextPatterns) {
        const match = normalizedText.match(pattern) || flatText.match(pattern);
        if (match) {
          return { value: match[1], mode: "high_context" };
        }
      }

      const allPeriods = [...flatText.matchAll(/\b(\d{5,})\b/g)].map(match => match[1]);
      if (allPeriods.length > 0) {
        return { value: allPeriods[0], mode: "generic_pair" };
      }

      return null;
    };

    const findPrediction = () => {
      const highContextPatterns = [
        /(?:BUY|PREDICTION|PREDICT|SIGNAL|RESULT|SIDE)\s*[:#=：-]?\s*(?:➡️|🔔|🎯|🎲|👉|🔥|\s){0,20}(BIG|SMALL|B|S|ကြီး|ငယ်|🔵🔵🔵|🔴🔴🔴|🟦🟦🟦|🟥🟥🟥)\b/i,
        /(?:BIG|SMALL|B|S|ကြီး|ငယ်|🔵🔵🔵|🔴🔴🔴|🟦🟦🟦|🟥🟥🟥)\s*(?:for|FOR|အတွက်)\s*\d{5,}/i
      ];

      for (const pattern of highContextPatterns) {
        const match = normalizedText.match(pattern) || flatText.match(pattern);
        if (match) {
          const value = pattern.source.includes("(?:for|FOR|အတွက်)") ? match[0].match(/(BIG|SMALL|B|S|ကြီး|ငယ်|🔵🔵🔵|🔴🔴🔴|🟦🟦🟦|🟥🟥🟥)/i)?.[1] : match[1];
          if (value) {
            return { value, mode: "high_context" };
          }
        }
      }

      const mediumContextPatterns = [
        /\b(BIG|SMALL)\b/i,
        /(ကြီး|ငယ်|🔵🔵🔵|🔴🔴🔴|🟦🟦🟦|🟥🟥🟥)/i
      ];

      for (const pattern of mediumContextPatterns) {
        const match = normalizedText.match(pattern) || flatText.match(pattern);
        if (match) {
          return { value: match[1], mode: "medium_context" };
        }
      }

      return null;
    };

    const periodInfo = findPeriod();
    const predictionInfo = findPrediction();

    if (periodInfo && predictionInfo) {
      const confidence = Math.max(
        getConfidence(periodInfo.mode),
        getConfidence(predictionInfo.mode)
      );
      const fallbackResult = buildResult(periodInfo.value, predictionInfo.value, confidence);
      if (fallbackResult) {
        return fallbackResult;
      }
    }
    
    return { valid: false };
  } catch (error) {
    logging.error(`Error parsing channel signal: ${error.message}`);
    return { valid: false };
  }
}

// ========== GAME FUNCTIONS ==========

async function getSpecificChannelPrediction(channelId, currentIssue) {
  try {
    logging.debug(`Getting prediction for channel ${channelId}, current issue: ${currentIssue}`);
    
    let signal = channelSignals[channelId]; 
    const now = Date.now();
    const currentPeriodShort = formatPeriod(currentIssue); 
    
    if (signal) {
      const signalAge = now - signal.receivedAt;
      const signalPeriodShort = signal.period ? signal.period.toString().slice(-5) : signal.period;
      
      logging.debug(`Signal found - Signal: ${signalPeriodShort}, Current: ${currentPeriodShort}, Age: ${Math.floor(signalAge / 1000)}s`);
      
      if (signalAge > CHANNEL_SIGNAL_EXPIRY_TIME) {
        logging.info(`Signal expired: age ${Math.floor(signalAge / 1000)}s > ${Math.floor(CHANNEL_SIGNAL_EXPIRY_TIME / 1000)}s`);
        delete channelSignals[channelId];
        return { 
          result: Math.random() < 0.5 ? 'B' : 'S', 
          shouldSkip: true,
          skipReason: "📡 Signal Expired",
          signalInfo: null
        };
      }
      
      if (signalPeriodShort === currentPeriodShort) {
        logging.info(`Period match found! Using signal: ${signal.prediction}`);
        return { 
          result: signal.prediction, 
          shouldSkip: false,
          skipReason: null,
          signalInfo: `Source: ${signal.name} (${Math.floor(signalAge / 1000)}s ago)`
        };
      } else {
        const signalPeriodNum = parseInt(signalPeriodShort);
        const currentPeriodNum = parseInt(currentPeriodShort);
        
        if (signalPeriodNum > currentPeriodNum) {
          logging.info(`Signal is for future period (${signalPeriodShort} > ${currentPeriodShort}), waiting...`);
          return { 
            result: Math.random() < 0.5 ? 'B' : 'S', 
            shouldSkip: true,
            skipReason: "📡 Waiting for Signal Period",
            signalInfo: null
          };
        } else {
          logging.info(`Period mismatch: signal ${signalPeriodShort} vs current ${currentPeriodShort} (signal is older)`);
          return { 
            result: Math.random() < 0.5 ? 'B' : 'S', 
            shouldSkip: true,
            skipReason: "📡 Period Not Match",
            signalInfo: null
          };
        }
      }
    } else {
      logging.info(`No signal found for channel ${channelId}. Checking...`);
      
      const maxWaitTime = CHANNEL_SIGNAL_WAIT_TIME;
      const startWaitTime = now;
      const checkInterval = 1000;
      const settings = userSettings[userId] || {};
      
      while (Date.now() - startWaitTime < maxWaitTime && settings.running) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        
        const updatedSignal = channelSignals[channelId];
        if (updatedSignal) {
          signal = updatedSignal;
          const signalAge = Date.now() - signal.receivedAt;
          const signalPeriodShort = signal.period ? signal.period.toString().slice(-5) : signal.period;
          
          if (signalPeriodShort === currentPeriodShort) {
            logging.info(`Signal received after ${Math.floor((Date.now() - startWaitTime) / 1000)}s wait`);
            return { 
              result: signal.prediction, 
              shouldSkip: false,
              skipReason: null,
              signalInfo: `Source: ${signal.name} (${Math.floor(signalAge / 1000)}s ago)`
            };
          }
        }
      }
      
      logging.info(`No signal received after ${Math.floor(maxWaitTime/1000)} seconds wait`);
      return { 
        result: Math.random() < 0.5 ? 'B' : 'S', 
        shouldSkip: true,
        skipReason: "📡 No Signal",
        signalInfo: null
      };
    }
    
  } catch (error) {
    logging.error(`Error in getSpecificChannelPrediction: ${error.message}`);
    return { result: 'S', shouldSkip: true, skipReason: "Error" };
  }
}

function shouldSkipPeriod(userId, strategy) {
  return false;
}

function resetSkipPeriods(userId) {
  delete userPeriodCounters[userId];
}

function getSkipMessage(userId, ch, strategy, gameType, currentIssue, periodCount) {
  const gameDisplay = getGameTypeDisplayName(gameType);
  return `🆔 ${gameDisplay}: ${formatPeriod(currentIssue)}\n🎲 Order: Waiting For ${periodCount}/4\n🚨 Value: ${strategy}`;
}

function getSkipResultMessage(userId, currentIssue, bigSmall, number, color, gameType, currentSkip, totalSkips) {
  const gameDisplay = getGameTypeDisplayName(gameType);
  return `🔴 Skip ${currentSkip}/${totalSkips}\n🆔 ${gameDisplay}: ${formatPeriod(currentIssue)} => ${bigSmall}•${number}`;
}

function checkPatternInHistory(history, pattern) {
  if (!history || history.length < pattern.length) {
    return false;
  }
  
  const historyStr = history.slice(-pattern.length).join('');
  return historyStr === pattern;
}

function checkConsecutiveSameResults(history) {
  if (!history || history.length < 2) {
    return false;
  }
  
  const lastTwo = history.slice(-2).join('');
  return lastTwo === 'BB' || lastTwo === 'SS';
}

async function getChatGPTPrediction(userId) {
  try {
    const session = userSessions[userId];
    const gameHistory = await getGameHistory(session);
    
    if (!gameHistory || gameHistory.length < 4) {
      logging.error(`Chat GPT Strategy: Not enough history data (need at least 4 results)`);
      return { result: Math.random() < 0.5 ? 'B' : 'S', percent: '50.0', shouldSkip: false };
    }
    
    const last4Results = gameHistory.slice(0, 4).map(item => {
      const number = parseInt(item.number) % 10;
      return number >= 5 ? 'B' : 'S';
    });
    
    const pattern = last4Results.join('');
    logging.info(`Chat GPT Strategy: Last 4 results pattern: ${pattern}`);
    
    if (CHATGPT_PATTERNS[pattern]) {
      const prediction = CHATGPT_PATTERNS[pattern];
      logging.info(`Chat GPT Strategy: Pattern ${pattern} matches, prediction: ${prediction}`);
      return { result: prediction, percent: 'N/A', shouldSkip: false };
    } else {
      logging.info(`Chat GPT Strategy: Pattern ${pattern} not found in defined patterns, skipping`);
      return { result: Math.random() < 0.5 ? 'B' : 'S', percent: 'N/A', shouldSkip: true };
    }
  } catch (error) {
    logging.error(`Error getting Chat GPT prediction: ${error.message}`);
    return { result: Math.random() < 0.5 ? 'B' : 'S', percent: '50.0', shouldSkip: false };
  }
}

async function getBreakerPrediction(userId, gameType) {
  try {
    const settings = userSettings[userId] || {};
    const streakCount = settings.breaker_streak_count || 3;
    
    if (gameType === "TRX") {
      const localHistory = userBreakerHistory[userId] || [];
      
      if (localHistory.length < streakCount) {
        return { 
          result: null, 
          percent: "N/A", 
          shouldSkip: true, 
          skipReason: `Breaker: Collecting History (${localHistory.length}/${streakCount})` 
        };
      }
      
      const lastNResults = localHistory.slice(-streakCount).map(item => item.bs);

      const allSame = lastNResults.every(val => val === lastNResults[0]);
      
      if (allSame) {
        const prediction = lastNResults[0] === 'B' ? 'S' : 'B';
        logging.info(`TRX Breaker: Found ${lastNResults.join('')}. Betting ${prediction}`);
        return { result: prediction, percent: "N/A", shouldSkip: false };
      } else {
        return { result: null, percent: "N/A", shouldSkip: true, skipReason: `Breaker Skip (No ${streakCount} Streak)` };
      }
    }

    const session = userSessions[userId];
    const gameHistory = await getGameHistory(session, gameType);
    
    if (!gameHistory || gameHistory.length < streakCount) {
      return { result: null, percent: "N/A", shouldSkip: true, skipReason: "History Data Not Enough" };
    }
    
    const lastNResults = gameHistory.slice(0, streakCount).map(item => {
      const number = parseInt(item.number) % 10;
      return number >= 5 ? 'B' : 'S';
    });

    const allSame = lastNResults.every(val => val === lastNResults[0]);
    
    if (allSame) {
      const prediction = lastNResults[0] === 'B' ? 'S' : 'B';
      logging.info(`Breaker: Found ${lastNResults.join('')}. Betting ${prediction}`);
      return { result: prediction, percent: "N/A", shouldSkip: false };
    } else {
      return { result: null, percent: "N/A", shouldSkip: true, skipReason: `Breaker Skip (No ${streakCount} Streak)` };
    }
    
  } catch (error) {
    logging.error(`Error getting Breaker prediction: ${error.message}`);
    return { result: null, percent: "N/A", shouldSkip: true, skipReason: "Breaker Error" };
  }
}

async function getDreamPrediction(userId) {
  try {
    const settings = userSettings[userId] || {};
    
    if (!settings.dream_state) {
      settings.dream_state = {
        first_bet: true,
        current_pattern: "",
        current_index: 0
      };
    }
    
    const dreamState = settings.dream_state;
    
    if (dreamState.first_bet) {
      logging.info(`DREAM: First bet, defaulting to B`);
      return { result: 'B', percent: 'N/A', shouldSkip: false };
    }
    
    if (dreamState.current_pattern && dreamState.current_index < dreamState.current_pattern.length) {
      const prediction = dreamState.current_pattern[dreamState.current_index];
      logging.info(`DREAM: Pattern ${dreamState.current_pattern}, index ${dreamState.current_index}, prediction: ${prediction}`);
      return { result: prediction, percent: 'N/A', shouldSkip: false };
    }
    
    logging.warning("DREAM: Invalid pattern state, defaulting to B");
    return { result: 'B', percent: '50.0', shouldSkip: false };
  } catch (error) {
    logging.error(`Error getting DREAM prediction: ${error.message}`);
    return { result: 'B', percent: '50.0', shouldSkip: false };
  }
}

function getAlinkarPrediction(userId) {
  try {
    if (!userResultHistory[userId] || userResultHistory[userId].length === 0) {
      const randomPrediction = Math.random() < 0.5 ? 'B' : 'S';
      logging.info(`ALINKAR: No history, random prediction: ${randomPrediction}`);
      return { result: randomPrediction, percent: '50.0', shouldSkip: false };
    }
    
    const results = userResultHistory[userId];
    
    let consecutiveCount = 1;
    const lastOutcome = results[results.length - 1];
    
    for (let i = results.length - 2; i >= 0; i--) {
      if (results[i] === lastOutcome) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    
    logging.info(`ALINKAR: ${consecutiveCount} consecutive ${lastOutcome}`);
    
    let prediction;
    if (consecutiveCount === 1) {
      prediction = lastOutcome === 'B' ? 'S' : 'B';
      logging.info(`ALINKAR: Single ${lastOutcome}, betting opposite: ${prediction}`);
    } else if (consecutiveCount === 2) {
      prediction = lastOutcome;
      logging.info(`ALINKAR: Double ${lastOutcome}, betting follow: ${prediction}`);
    } else if (consecutiveCount === 3) {
      prediction = lastOutcome === 'B' ? 'S' : 'B';
      logging.info(`ALINKAR: Triple ${lastOutcome}, betting opposite: ${prediction}`);
    } else {
      prediction = lastOutcome;
      logging.info(`ALINKAR: ${consecutiveCount}x ${lastOutcome}, betting follow: ${prediction}`);
    }
    
    return { result: prediction, percent: 'N/A', shouldSkip: false };
  } catch (error) {
    logging.error(`Error getting ALINKAR prediction: ${error.message}`);
    return { result: Math.random() < 0.5 ? 'B' : 'S', percent: '50.0', shouldSkip: false };
  }
}

async function getMayBaraniPrediction(userId) {
  try {
    if (!userResultHistory[userId] || userResultHistory[userId].length === 0) {
      logging.info(`MAY BARANI: No history, defaulting to B`);
      return { result: 'B', percent: 'N/A', shouldSkip: false };
    }
    
    const results = userResultHistory[userId];
    
    if (results.length < 5) {
      const lastResult = results[results.length - 1];
      logging.info(`MAY BARANI: Not enough results (${results.length}), using last: ${lastResult}`);
      return { result: lastResult, percent: 'N/A', shouldSkip: false };
    }
    
    const toNum = (r) => r === 'B' ? 7 : 2;
    
    const latest5 = results.slice(-5);
    const remaining = results.slice(0, -5);
    
    const sumLatest5 = latest5.reduce((acc, r) => acc + toNum(r), 0);
    const sumRemaining = remaining.reduce((acc, r) => acc + toNum(r), 0);
    
    let diff = sumLatest5 - sumRemaining;
    logging.info(`MAY BARANI: S5=${sumLatest5}, R=${sumRemaining}, Diff=${diff}`);
    
    const isTwoDigit = Math.abs(diff) >= 10;
    let finalResult = Math.abs(diff);
    
    if (finalResult >= 10) {
      finalResult = finalResult % 10;
    }
    
    let prediction;
    if (isTwoDigit) {
      if (finalResult >= 5) {
        prediction = 'S'; 
      } else {
        prediction = 'B'; 
      }
      logging.info(`MAY BARANI: Two-digit result ${finalResult}, opposite prediction: ${prediction}`);
    } else {
      if (finalResult >= 5) {
        prediction = 'B';
      } else {
        prediction = 'S';
      }
      logging.info(`MAY BARANI: Single-digit result ${finalResult}, same prediction: ${prediction}`);
    }
    
    return { result: prediction, percent: 'N/A', shouldSkip: false };
  } catch (error) {
    logging.error(`Error getting MAY BARANI prediction: ${error.message}`);
    return { result: 'B', percent: '50.0', shouldSkip: false };
  }
}

const ensureDataDir = () => {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
};

function loadUserSettings() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'user_settings.json');
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      Object.assign(userSettings, data);
      logging.info(`Loaded user settings for ${Object.keys(data).length} users`);
    } else {
      logging.warning("user_settings.json not found. Starting with empty settings");
      fs.writeFileSync(filePath, JSON.stringify({}, null, 4));
    }
  } catch (error) {
    logging.error(`Error loading user_settings.json: ${error.message}`);
  }
}

function saveUserSettings() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'user_settings.json');
    
    fs.writeFileSync(filePath, JSON.stringify(userSettings, null, 4));
    logging.info(`Saved user settings for ${Object.keys(userSettings).length} users`);
  } catch (error) {
    logging.error(`Error saving user settings: ${error.message}`);
  }
}

function updateUserSetting(userId, key, value) {
  if (!userSettings[userId]) {
    userSettings[userId] = getDefaultUserSettings();
  }
  userSettings[userId][key] = value;
  saveUserSettings();
}

function getDefaultUserSettings() {
  return {
    strategy: "CHANNEL_SIGNAL", 
    betting_strategy: "Martingale",
    game_type: "TRX",
    bet_type: "BS",
    martin_index: 0,
    dalembert_units: 1,
    pattern_index: 0,
    running: false,
    consecutive_losses: 0,
    current_layer: 0,
    skip_betting: false,
    sl_layer: null,
    original_martin_index: 0,
    original_dalembert_units: 1,
    original_custom_index: 0,
    custom_index: 0,
    layer_limit: 1,
    virtual_mode: false,
    admin_virtual_mode: false,
    bet_sizes: [100],
    bs_wait_count: 0,
    bs_wait_active: false,
    bs_wait_remaining: 0,
    fallback_on_expired_signal: true,
    min_signal_confidence: 60, 
    target_channel_id: null,
    target_profit: null,
    stop_loss: null,
    lose_sl: null,
    lose_sl_consecutive_losses: 0,
    lose_sl_skip_count: 0,
    lose_sl_skipped_count: 0,
    lose_sl_active: false,
    bet_direction: "STRAIGHT" ,
    breaker_streak_count: 3,
    consecutive_loss_limit: null,    
    consecutive_loss_count: 0,     
    alert_sent_for_this_streak: false,     
    dream_state: null
  };
}

function loadBypassUsers() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'bypass_users.json');
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      bypassMinBalanceUsers = new Set(data.users || []);
      console.log(`Loaded ${bypassMinBalanceUsers.size} bypass users`);
    } else {
      bypassMinBalanceUsers = new Set();
      fs.writeFileSync(filePath, JSON.stringify({ users: [] }, null, 4));
    }
  } catch (error) {
    console.error(`Error loading bypass users: ${error.message}`);
    bypassMinBalanceUsers = new Set();
  }
}

function saveBypassUsers() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'bypass_users.json');
    
    fs.writeFileSync(filePath, JSON.stringify({ 
      users: Array.from(bypassMinBalanceUsers) 
    }, null, 4));
    console.log(`Saved ${bypassMinBalanceUsers.size} bypass users`);
  } catch (error) {
    console.error(`Error saving bypass users: ${error.message}`);
  }
}

function loadAllowedUsers() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'users_6lottery.json');
    const permanentAllowedIds = new Set([
      286994, 929793, 816396, 540349, 1017791, 102076, 1125519
    ]);
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const fileIds = new Set(data.allowed_ids || []);
      allowed777bigwinIds = new Set([...permanentAllowedIds, ...fileIds]);
      if (fileIds.size !== allowed777bigwinIds.size) {
        saveAllowedUsers();
      }
      
      logging.info(`Loaded ${allowed777bigwinIds.size} users (${permanentAllowedIds.size} permanent + ${fileIds.size} from file)`);
    } else {
      logging.warning("users_6lottery.json not found. Using permanent allowed IDs only");
      allowed777bigwinIds = permanentAllowedIds;
      saveAllowedUsers();
    }
  } catch (error) {
    logging.error(`Error loading users_6lottery.json: ${error.message}`);
    const permanentAllowedIds = new Set([
      286994, 929793, 816396, 540349, 1017791
    ]);
    allowed777bigwinIds = permanentAllowedIds;
  }
}

function saveAllowedUsers() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'users_6lottery.json');
    
    fs.writeFileSync(filePath, JSON.stringify({ 
      allowed_ids: Array.from(allowed777bigwinIds) 
    }, null, 4));
    logging.info(`Saved ${allowed777bigwinIds.size} users`);
  } catch (error) {
    logging.error(`Error saving user list: ${error.message}`);
  }
}

function loadAllUsers() {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'all_users.json');
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return new Set(data.users || []);
    } else {
      logging.warning("all_users.json not found. Starting new");
      return new Set();
    }
  } catch (error) {
    logging.error(`Error loading all_users.json: ${error.message}`);
    return new Set();
  }
}

function saveAllUsers(allUsersSet) {
  try {
    const dataDir = ensureDataDir();
    const filePath = path.join(dataDir, 'all_users.json');
    
    fs.writeFileSync(filePath, JSON.stringify({ 
      users: Array.from(allUsersSet),
      last_updated: new Date().toISOString()
    }, null, 4));
    logging.info(`Saved ${allUsersSet.size} total users`);
  } catch (error) {
    logging.error(`Error saving all users list: ${error.message}`);
  }
}

function addUserToAllList(userId) {
  if (!allUsers.has(userId)) {
    allUsers.add(userId);
    saveAllUsers(allUsers);
    logging.info(`Added user ${userId} to all users list`);
  }
}

async function acquireCommandLock(userId) {
  if (userCommandLocks[userId]) {
    return false;
  }
  userCommandLocks[userId] = true;
  return true;
}

function releaseCommandLock(userId) {
  delete userCommandLocks[userId];
}

async function withCommandLock(userId, fn) {
  if (!await acquireCommandLock(userId)) {
    return { success: false, message: "🔄 Please wait, processing previous command..." };
  }
  
  try {
    const result = await fn();
    return { success: true, data: result };
  } catch (error) {
    logging.error(`Command execution error for user ${userId}: ${error.message}`);
    return { success: false, message: `❌ Error: ${error.message}` };
  } finally {
    releaseCommandLock(userId);
  }
}

function getSelectMap(betType) {
  if (betType === "COLOR") {
    return { "G": 11, "V": 12, "R": 10 };
  } else {
    return { "B": 13, "S": 14 };
  }
}

function numberToBS(num) {
  return num >= 5 ? 'B' : 'S';
}

function numberToColor(num) {
  if (COLORS.GREEN.numbers.includes(num)) return 'G';
  if (COLORS.VIOLET.numbers.includes(num)) return 'V';
  if (COLORS.RED.numbers.includes(num)) return 'R';
  return 'G';
}

function getColorName(colorCode) {
  switch(colorCode) {
    case 'G': return COLORS.GREEN.name;
    case 'V': return COLORS.VIOLET.name;
    case 'R': return COLORS.RED.name;
    default: return 'Unknown';
  }
}

function getGameTypeDisplayName(gameType) {
  switch(gameType) {
    case "TRX":
      return " 𝐓𝐑𝐗";
    case "WINGO30S":
      return "𝐖𝐈𝐍𝐆𝐎 𝟑𝟎𝐒";
    default:
      return gameType;
  }
}

function getPlatformDisplayName(apiUrl) {
  for (const [platform, url] of Object.entries(PLATFORMS)) {
    if (url === apiUrl) {
      switch(platform) {
        case "6LOTTERY":
          return "𝟔𝐋𝐎𝐓𝐓𝐄𝐑𝐘";
        case "777BIGWIN":
          return "𝟟𝟟𝟟 𝐁𝐈𝐆𝐖𝐈𝐍";
        case "CKLOTTERY":
          return "𝐂𝐤-𝐋𝐎𝐓𝐓𝐄𝐑𝐘";
        default:
          return "𝟔𝐋𝐎𝐓𝐓𝐄𝐑𝐘";
      }
    }
  }
  return "𝟔𝐋𝐎𝐓𝐓𝐄𝐑𝐘";
}

async function getWingoGameResults(session, gameType = "WINGO30S") {
    const body = {
        pageSize: 10,
        typeId: 30,
        language: 7,
        random: "616fb37000504db2beab210b50c74498",
        signature: "28EC22FF6CB095E3F04C3C5DD663BFA5",
        timestamp: Math.floor(Date.now() / 1000)
    };

    try {
        const response = await enhancedPostRequest(session, "GetNoaverageEmerdList", body, session.userId || 'unknown');
        const data = response;

        if (data && data.code === 0 && data.data && data.data.list) {
            logging.info(`WINGO30S result count: ${data.data.list.length}`);
            return data;
        } else {
            logging.error(`Invalid data received from WINGO API: ${JSON.stringify(data)}`);
            return { code: -1, msg: "Invalid data from WINGO API" };
        }
    } catch (error) {
        logging.error(`Error while fetching WINGO30S results: ${error.message}`);
        return { error: error.message };
    }
}

async function getGameIssueRequest(session, gameType = "TRX") {
  const gameConfig = GAME_TYPES[gameType] || GAME_TYPES.TRX;
  const body = {
    "typeId": gameConfig.typeId,
    "language": gameConfig.language,
    "random": gameConfig.random
  };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  
  try {
    const response = await enhancedPostRequest(session, gameConfig.endpoint, body, session.userId || 'unknown');
    logging.info(`${gameType} game issue request`);
    return response;
  } catch (error) {
    logging.error(`${gameType} game issue error: ${error.message}`);
    return { error: error.message };
  }
}

async function placeBetRequest(session, issueNumber, selectType, unitAmount, betCount, gameType, userId) {
  const gameConfig = GAME_TYPES[gameType] || GAME_TYPES.TRX;
  const settings = userSettings[userId] || {};
  const betType = settings.bet_type || "BS";
  const actualGameType = betType === "COLOR" ? 0 : 2;
  
  const betBody = {
    "typeId": gameConfig.typeId,
    "issuenumber": issueNumber,
    "language": gameConfig.language,
    "gameType": actualGameType,
    "amount": unitAmount,
    "betCount": betCount,
    "selectType": selectType,
    "random": gameConfig.random
  };
  
  betBody.signature = generateSignature(betBody).toUpperCase();
  betBody.timestamp = Math.floor(Date.now() / 1000);
  
  for (let attempt = 0; attempt < MAX_BET_RETRIES; attempt++) {
    try {
      const response = await enhancedPostRequest(session, gameConfig.betEndpoint, betBody, userId);
      const res = response;
      logging.info(`Bet request for user ${userId}, ${gameType}, issue ${issueNumber}, select_type ${selectType}, amount ${unitAmount * betCount}`);
      return res;
    } catch (error) {
      logging.error(`Bet error for user ${userId}, attempt ${attempt + 1}: ${error.message}`);
      
      if (attempt < MAX_BET_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, BET_RETRY_DELAY * 1000));
        continue;
      }
      return { error: "Failed after retries" };
    }
  }
  return { error: "Failed after retries" };
}

async function loginRequest(phone, password, baseUrl = DEFAULT_BASE_URL) {
  if (!baseUrl.endsWith('/')) baseUrl += '/';

  const loginData = {
    username: "95" + phone,
    pwd: password,
    phonetype: 1,
    logintype: "mobile",
    packId: "",
    deviceId: "5dcab3e06db88a206975e91ea6ac7c87",
    language: 7,
    random: crypto.randomBytes(16).toString('hex'),
  };
  
  const signature = generateSignature(loginData);
  loginData.signature = signature;
  loginData.timestamp = Math.floor(Date.now() / 1000);
  
  try {
    const response = await axios.post(
      baseUrl + "Login",
      loginData,
      {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Ar-Origin": "https://6win598.com",
          "Origin": "https://6win598.com",
          "Referer": "https://6win598.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
        },
        timeout: 15000,
      }
    );
    
    const res = response.data;
    if (res.code === 0 && res.data) {
      const tokenHeader = res.data.tokenHeader || "Bearer ";
      const token = res.data.token || "";
      
      const session = {
        post: async (endpoint, data) => {
          return await enhancedPostRequest({ 
            platform: baseUrl, 
            token: token,
            post: async (endpoint, data) => {
              return await enhancedPostRequest({ platform: baseUrl, token: token }, endpoint, data, 'unknown');
            }
          }, endpoint, data, 'unknown');
        },
        platform: baseUrl,
        token: token,
        userId: 'unknown'
      };
      return { response: res, session };
    }
    return { response: res, session: null };
  } catch (error) {
    logging.error(`Login error: ${error.message}`);
    return { response: { error: error.message }, session: null };
  }
}

async function getUserInfo(session, userId) {
  const body = {
    "language": 7,
    "random": "d713b04404a04d03964502718194fd0c"
  };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  
  try {
    const response = await enhancedPostRequest(session, "GetUserInfo", body, userId);
    const res = response;
    if (res.code === 0 && res.data) {
      const info = {
        "user_id": res.data.userId,
        "username": res.data.userName,
        "nickname": res.data.nickName,
        "balance": res.data.amount,
        "photo": res.data.userPhoto,
        "login_date": res.data.userLoginDate,
        "withdraw_count": res.data.withdrawCount,
        "is_allow_withdraw": res.data.isAllowWithdraw === 1
      };
      userGameInfo[userId] = info;
      return info;
    }
    return null;
  } catch (error) {
    logging.error(`Get user info error: ${error.message}`);
    return null;
  }
}

async function getBalance(session, userId) {
  try {
    const body = {
      "language": 7,
      "random": "113627006f984ecb96675f8cf15827d1"
    };
    
    body.signature = generateSignature(body).toUpperCase();
    body.timestamp = Math.floor(Date.now() / 1000);
    
    const response = await enhancedPostRequest(session, "GetBalance", body, userId);
    
    if (response && response.code === 0 && response.data) {
      const data = response.data;
      
      let balanceAmount = null;
      
      if (data.Amount !== undefined) {
        balanceAmount = data.Amount;
      } else if (data.amount !== undefined) {
        balanceAmount = data.amount;
      } else if (data.balance !== undefined) {
        balanceAmount = data.balance;
      } else if (typeof data === 'number') {
        balanceAmount = data;
      } else if (typeof data === 'string') {
        balanceAmount = parseFloat(data);
      }
      
      if (balanceAmount !== null && balanceAmount !== undefined) {
        const balance = parseFloat(balanceAmount);
        
        if (userGameInfo[userId]) {
          userGameInfo[userId].balance = balance;
        }
        
        if (!userStats[userId]) {
          userStats[userId] = { start_balance: balance, profit: 0.0 };
        } else if (userStats[userId].start_balance === 0) {
          userStats[userId].start_balance = balance;
        }
        
        logging.info(`Balance check successful for user ${userId}: ${balance} Ks`);
        return balance;
      } else {
        logging.warning(`No balance amount found in response for user ${userId}: ${JSON.stringify(data)}`);
      }
    } else {
      const errorMsg = response?.msg || response?.error || 'Unknown error';
      logging.warning(`Get balance API returned error for user ${userId}: ${errorMsg}`);
    }
    
    return null;
  } catch (error) {
    logging.error(`Balance check error for user ${userId}: ${error.message}`);
    
    if (error.message.includes('unauthorized') || error.message.includes('token') || error.message.includes('login')) {
      logging.info(`Authentication error detected for user ${userId}, attempting auto-login...`);
      const bot = sessionBotMap.get(userId) || null;
      const autoLoginSuccess = await robustAutoLogin(userId, bot);
      if (autoLoginSuccess) {
        const newSession = userSessions[userId];
        if (newSession) {
          return await getBalance(newSession, userId);
        }
      }
    }
    
    return null;
  }
}

function getValidDalembertBetAmount(unitSize, currentUnits, balance, minBet) {
  let amount = unitSize * currentUnits;
  
  while (amount > balance && currentUnits > 1) {
    currentUnits--;
    amount = unitSize * currentUnits;
  }
  
  if (amount > balance) {
    amount = balance;
  }
  
  if (amount < minBet) {
    amount = minBet;
  }
  
  return { amount: amount, adjustedUnits: currentUnits };
}

function computeBetDetails(desiredAmount) {
  if (desiredAmount <= 0) {
    return { unitAmount: 0, betCount: 0, actualAmount: 0 };
  }
  
  const unitAmount = computeUnitAmount(desiredAmount);
  const betCount = Math.max(1, Math.floor(desiredAmount / unitAmount));
  const actualAmount = unitAmount * betCount;
  
  return { unitAmount, betCount, actualAmount };
}

function calculateBetAmount(settings, currentBalance) {
  const bettingStrategy = settings.betting_strategy || "Martingale";
  const betSizes = settings.bet_sizes || [100];
  const minBetSize = Math.min(...betSizes);
  
  logging.debug(`Calculating bet amount - Strategy: ${bettingStrategy}, Bet Sizes: [${betSizes.join(', ')}]`);
  
  if (bettingStrategy === "D'Alembert") {
    if (betSizes.length > 1) {
      throw new Error("D'Alembert strategy requires only ONE bet size");
    }
    
    const unitSize = betSizes[0];
    let units = settings.dalembert_units || 1;
    
    const { amount: validAmount, adjustedUnits } = getValidDalembertBetAmount(unitSize, units, currentBalance, minBetSize);
    
    if (adjustedUnits !== units) {
      settings.dalembert_units = adjustedUnits;
      units = adjustedUnits;
      logging.info(`D'Alembert: Adjusted units to ${units} due to balance constraints`);
    }
    
    logging.info(`D'Alembert: Betting ${validAmount} (${units} units of ${unitSize})`);
    return validAmount;
    
  } else if (bettingStrategy === "Custom") {
    const customIndex = settings.custom_index || 0;
    const adjustedIndex = Math.min(customIndex, betSizes.length - 1);
    const amount = betSizes[adjustedIndex];
    logging.info(`Custom: Betting ${amount} at index ${adjustedIndex}`);
    return amount;
    
  } else {
    const martinIndex = settings.martin_index || 0;
    const adjustedIndex = Math.min(martinIndex, betSizes.length - 1);
    const amount = betSizes[adjustedIndex];
    logging.info(`${bettingStrategy}: Betting ${amount} at index ${adjustedIndex}`);
    return amount;
  }
}

function updateBettingStrategy(settings, isWin, betAmount) {
  const bettingStrategy = settings.betting_strategy || "Martingale";
  const betSizes = settings.bet_sizes || [100];
  
  logging.debug(`Updating betting strategy - Strategy: ${bettingStrategy}, Result: ${isWin ? 'WIN' : 'LOSS'}, Bet Amount: ${betAmount}`);
  
  if (isWin) {
    if (settings.consecutive_losses >= (settings.sl_layer || 0)) {
      settings.consecutive_losses = 0;
      logging.info(`Betting strategy: Win after SL Skip - Resetting consecutive losses to 0`);
    }
  }
  
  if (bettingStrategy === "Martingale") {
    if (isWin) {
      settings.martin_index = 0;
      logging.info("Martingale: Win - Reset to index 0");
    } else {
      settings.martin_index = Math.min((settings.martin_index || 0) + 1, betSizes.length - 1);
      logging.info(`Martingale: Loss - Move to index ${settings.martin_index}`);
    }
    
  } else if (bettingStrategy === "Anti-Martingale") {
    if (isWin) {
      settings.martin_index = Math.min((settings.martin_index || 0) + 1, betSizes.length - 1);
      logging.info(`Anti-Martingale: Win - Move to index ${settings.martin_index}`);
    } else {
      settings.martin_index = 0;
      logging.info("Anti-Martingale: Loss - Reset to index 0");
    }
    
  } else if (bettingStrategy === "D'Alembert") {
    if (isWin) {
      settings.dalembert_units = Math.max(1, (settings.dalembert_units || 1) - 1);
      logging.info(`D'Alembert: Win - Decrease units to ${settings.dalembert_units}`);
    } else {
      settings.dalembert_units = (settings.dalembert_units || 1) + 1;
      logging.info(`D'Alembert: Loss - Increase units to ${settings.dalembert_units}`);
    }
    
  } else if (bettingStrategy === "Custom") {
    const currentIndex = settings.custom_index || 0;
    
    let actualIndex = 0;
    for (let i = 0; i < betSizes.length; i++) {
      if (betSizes[i] === betAmount) {
        actualIndex = i;
        break;
      }
    }
    
    if (isWin) {
      if (actualIndex > 0) {
        settings.custom_index = actualIndex - 1;
      } else {
        settings.custom_index = 0;
      }
      logging.info(`Custom: Win - Move to index ${settings.custom_index}`);
    } else {
      if (actualIndex < betSizes.length - 1) {
        settings.custom_index = actualIndex + 1;
      } else {
        settings.custom_index = betSizes.length - 1;
      }
      logging.info(`Custom: Loss - Move to index ${settings.custom_index}`);
    }
  }
  
  saveUserSettings();
}

async function getGameHistory(session, gameType = "TRX") {
  const gameConfig = GAME_TYPES[gameType] || GAME_TYPES.TRX;
  const body = {
    "pageSize": 10,
    "typeId": gameConfig.typeId,
    "language": gameConfig.language,
    "random": "f15bdcc4e6a04f82828b2f7a7b4c6e5a"
  };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  
  try {
    const response = await enhancedPostRequest(session, "GetNoaverageEmerdList", body, session.userId || 'unknown');
    const data = response?.data?.list || [];
    logging.debug(`Game history response: ${data.length} records retrieved`);
    
    const validData = data.filter(item => item && item.number !== undefined && item.number !== null);
    logging.debug(`Game history valid records: ${validData.length} out of ${data.length}`);
    
    return validData;
  } catch (error) {
    logging.error(`Error fetching game history: ${error.message}`);
    return [];
  }
}

async function sendMessageWithRetry(ctx, text, replyMarkup = null) {
  if (!ctx || !ctx.telegram) return null;
  
  try {
    if (replyMarkup && replyMarkup.reply_markup) {
      return await ctx.reply(text, replyMarkup);
    } else if (replyMarkup && !replyMarkup.reply_markup) {
      return await ctx.reply(text, replyMarkup);
    } else {
      return await ctx.reply(text);
    }
  } catch (error) {
    logging.error(`sendMessageWithRetry error: ${error.message}`);
    return null;
  }
}

function applyBetDirection(prediction, betType, direction) {
  if (direction !== "REVERSE") {
    return prediction;
  }
  
  if (!prediction) {
    return prediction;
  }
  
  if (betType === "BS") {
    if (prediction === "B" || prediction === "BIG") {
      return "S";
    } else if (prediction === "S" || prediction === "SMALL") {
      return "B";
    }
  }
  
  if (betType === "COLOR") {
    if (prediction === "G" || prediction === "GREEN") {
      return "R";
    } else if (prediction === "R" || prediction === "RED") {
      return "G";
    } else if (prediction === "V" || prediction === "VIOLET") {
      return "G";
    }
  }
  
  return prediction;
}

function resetSLSkipState(userId) {
  const settings = userSettings[userId] || {};
  
  settings.consecutive_losses = 0;
  userShouldSkipNext[userId] = false;
  delete userSLSkipWaitingForWin[userId];
  
  settings.martin_index = settings.original_martin_index || 0;
  settings.dalembert_units = settings.original_dalembert_units || 1;
  settings.custom_index = settings.original_custom_index || 0;
  
  logging.info(`SL Skip state completely reset for user ${userId}`);
  saveUserSettings();
}

function resetEntryLayer(userId) {
  const settings = userSettings[userId] || {};
  const entryLayer = settings.layer_limit || 1;
  
  if (entryLayer >= 2 && entryLayer <= 9) {
    if (entryLayer === 2) {
      settings.entry_layer_state = { 
        waiting_for_loses: true, 
        consecutive_loses: 0,
        required_loses: 1,
        real_betting_started: false
      };
    } else if (entryLayer === 3) {
      settings.entry_layer_state = { 
        waiting_for_loses: true, 
        consecutive_loses: 0,
        required_loses: 2,
        real_betting_started: false
      };
    } else if (entryLayer >= 4 && entryLayer <= 9) {
      settings.entry_layer_state = { 
        waiting_for_loses: true, 
        consecutive_loses: 0,
        required_loses: entryLayer - 1,
        real_betting_started: false
      };
    }
    logging.info(`Entry Layer ${entryLayer} completely reset for user ${userId}`);
  }
}

function getMyanmarTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const myanmarTime = new Date(utc + (3600000 * 6.5)); 
  return myanmarTime;
}

function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getCurrentCycleDate() {
  const mt = getMyanmarTime();
  return mt.toISOString().slice(0, 10);
}

function loadTRXData() {
  try {
    if (fs.existsSync(TRX_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRX_DATA_FILE, 'utf8'));
      trxDataCache = data;
      logging.info(`Loaded TRX Data for Cycle: ${trxDataCache.cycleDate}`);
    }
  } catch (error) {
    logging.error(`Error loading TRX data: ${error.message}`);
  }
  checkTRXCycleReset();
}

function saveTRXData() {
  try {
    fs.writeFileSync(TRX_DATA_FILE, JSON.stringify(trxDataCache, null, 2));
  } catch (error) {
    logging.error(`Error saving TRX data: ${error.message}`);
  }
}

function checkTRXCycleReset() {
  const currentCycle = getCurrentCycleDate();
  
  if (trxDataCache.cycleDate !== currentCycle) {
    logging.info(`TRX Cycle Reset detected. New Cycle: ${currentCycle}`);
    trxDataCache = {
      cycleDate: currentCycle,
      big: 0,
      small: 0,
      lastIssue: ""
    };
    saveTRXData();
  }
}

function recordTRXOutcome(issue, number) {
  checkTRXCycleReset();

  if (trxDataCache.lastIssue === issue) return false;

  const hour = getMyanmarTime().getHours();
  if (hour < 6) {
    trxDataCache.lastIssue = issue;
    saveTRXData();
    return false;
  }

  const isBig = number >= 5;
  if (isBig) {
    trxDataCache.big++;
  } else {
    trxDataCache.small++;
  }

  trxDataCache.lastIssue = issue;
  saveTRXData();
  return true;
}

function getTRXStats() {
  checkTRXCycleReset();
  return {
    date: trxDataCache.cycleDate,
    big: trxDataCache.big,
    small: trxDataCache.small,
    total: trxDataCache.big + trxDataCache.small
  };
}

async function createTRXImage(stats) {
  try {
    const canvasObj = canvas.createCanvas(600, 400);
    const ctx = canvasObj.getContext('2d');

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvasObj.width, canvasObj.height);

    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('📊 TRX DAILY TRACKER', canvasObj.width / 2, 60);

    ctx.font = '20px Arial';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`Date: ${stats.date}`, canvasObj.width / 2, 100);

    const total = stats.total || 1;
    const bigRate = ((stats.big / total) * 100).toFixed(1);
    const smallRate = ((stats.small / total) * 100).toFixed(1);

    ctx.fillStyle = '#2ecc71';
    ctx.fillRect(100, 150, 150, 150);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Arial';
    ctx.fillText('BIG', 175, 200);
    ctx.font = 'bold 40px Arial';
    ctx.fillText(`${stats.big}`, 175, 260);
    ctx.font = '20px Arial';
    ctx.fillText(`(${bigRate}%)`, 175, 290);

    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(350, 150, 150, 150);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Arial';
    ctx.fillText('SMALL', 425, 200);
    ctx.font = 'bold 40px Arial';
    ctx.fillText(`${stats.small}`, 425, 260);
    ctx.font = '20px Arial';
    ctx.fillText(`(${smallRate}%)`, 425, 290);

    ctx.font = '20px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`Total Rounds: ${stats.total}`, canvasObj.width / 2, 360);

    return canvasObj.toBuffer('image/png');
  } catch (error) {
    logging.error(`Error creating TRX Image: ${error.message}`);
    return null;
  }
}

// ========== BOT HEALTH MONITOR ==========

async function startBotHealthMonitor(bot) {
  logging.info("🔍 Starting Bot Health Monitor (5-second interval)");
  
  setInterval(async () => {
    try {
      for (const userId in userSettings) {
        const settings = userSettings[userId];
        
        if (settings && settings.running) {
          // Only check session validity for REAL mode
          if (!settings.virtual_mode) {
            const isSessionValid = await ensureValidSessionMain(userId, bot);
            
            if (!isSessionValid) {
              logging.warning(`⚠️ User ${userId} session invalid during bot run. Attempting recovery...`);
              
              const loginSuccess = await robustAutoLogin(userId, bot);
              
              if (loginSuccess) {
                logging.info(`✅ User ${userId} session recovered via auto-login`);
                
                try {
                  await sendMessageWithRateLimit(bot, userId,
                    "🔄 Session recovered automatically!\n\n" +
                    "Your bot is still running and all settings have been preserved.",
                    { parse_mode: 'HTML', disable_notification: true }
                  );
                } catch (error) {
                  logging.error(`Failed to notify user ${userId} about session recovery: ${error.message}`);
                }
              } else {
                logging.error(`❌ Failed to recover session for user ${userId}. Stopping bot to prevent errors.`);
                
                settings.running = false;
                
                try {
                  await sendMessageWithRateLimit(bot, userId,
                    "❌ Session recovery failed!\n\n" +
                    "Your bot has been stopped to prevent errors.\n" +
                    "Please login again to continue.",
                    makeMainKeyboard(false, userId)
                  );
                } catch (error) {
                  logging.error(`Failed to notify user ${userId} about session failure: ${error.message}`);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logging.error(`Bot Health Monitor error: ${error.message}`);
    }
  }, 5000); 
}

async function startTRXLogger() {
  logging.info("🚀 TRX File Loader started...");
  
  while (true) {
    try {
      const response = await getTRXGameResultsNew(null, "TRX");
      
      if (response && response.data && response.data.list && response.data.list.length > 0) {
        const latest = response.data.list[0]; 
        const issue = latest.issueNumber;
        const number = parseInt(latest.number || "0") % 10;
        
        recordTRXOutcome(issue, number);
      }
    } catch (error) {
      logging.error(`TRX Logger Loop Error: ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

async function ensureBotContinuesRunning(bot) {
  logging.info("🔄 Starting Bot Continuity Monitor (30-second interval)");
  
  setInterval(async () => {
    try {
      for (const userId in userSettings) {
        const settings = userSettings[userId];
        
        if (settings && settings.running) {
          const lastActivity = userLastActivity[userId] || 0;
          const now = Date.now();
          
          if (now - lastActivity > 120000) {
            logging.warning(`⚠️ User ${userId} bot appears to be inactive. Restarting betting worker...`);
            
            userWaitingForResult[userId] = false;
            delete userPendingBets[userId];
            delete userSkippedBets[userId];
            delete userShouldSkipNext[userId];
            delete userSLSkipWaitingForWin[userId];
            delete userDelayUntil[userId];
            
            const fakeCtx = {
              from: { id: parseInt(userId) },
              telegram: bot.telegram,
              reply: async (msg, options) => {
                try {
                  await sendMessageWithRateLimit(bot, userId, msg, options);
                } catch (error) {
                  logging.error(`Failed to send message to user ${userId}: ${error.message}`);
                }
              }
            };
            
            bettingWorker(userId, fakeCtx, bot);
            
            logging.info(`✅ User ${userId} betting worker restarted`);
          }
        }
      }
    } catch (error) {
      logging.error(`Bot Continuity Monitor error: ${error.message}`);
    }
  }, 30000);
}

const userLastActivity = {};
function updateUserActivity(userId) {
  userLastActivity[userId] = Date.now();
}

// ========== BETTING WORKER - FIXED WITH SESSION UPDATE ==========

async function bettingWorker(userId, ctx, bot) {
  const settings = userSettings[userId] || {};
  let session = userSessions[userId];
  const gameType = settings.game_type || "TRX";
  const betType = settings.bet_type || "BS";
  
  updateUserActivity(userId);
  
  if (!settings || !session) {
    await ctx.reply("Please login first");
    settings.running = false;
    return;
  }
 
  if (!settings.virtual_mode) {
   
    if (!await ensureValidSessionMain(userId, bot)) {
      await ctx.reply("❌ Auto-login failed. Please login again.", makeMainKeyboard(false, userId));
      settings.running = false;
      return;
    }
   
    session = userSessions[userId];
  }
  
  let currentBalance = null;
  
  if (settings.virtual_mode) {
    if (settings.admin_virtual_mode) {
      currentBalance = userStats[userId]?.admin_virtual_balance || 0;
      if (!userStats[userId]?.admin_start_balance) {
        userStats[userId] = userStats[userId] || {};
        userStats[userId].admin_start_balance = currentBalance;
      }
    } else {
      currentBalance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
    }
  } else {
    let balanceRetrieved = false;
    
    for (let attempt = 0; attempt < MAX_BALANCE_RETRIES; attempt++) {
      try {
        const balanceResult = await safeExecute(userId, () => getBalance(session, parseInt(userId)), null);
        if (balanceResult !== null) {
          currentBalance = balanceResult;
          userStats[userId].start_balance = currentBalance;
          balanceRetrieved = true;
          break;
        }
      } catch (error) {
        logging.error(`Balance check attempt ${attempt + 1} failed: ${error.message}`);
      }
      
      if (attempt < MAX_BALANCE_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, BALANCE_RETRY_DELAY * 1000));
      }
    }
    
    if (!balanceRetrieved) {
      await ctx.reply("ကျေးဇူးပြု၍ LOGIN ပြန်ဝင်ပါ(❌Please check your connection or try again)", makeMainKeyboard(true, userId));
      settings.running = false;
      return;
    }
  }
  
  // ========== MINIMUM BALANCE CHECK WITH BYPASS SYSTEM ==========
  const canBypassMinBalance = bypassMinBalanceUsers.has(parseInt(userId));
  const isAdmin = ADMIN_IDS.includes(parseInt(userId));
  const canSkipBalanceCheck = canBypassMinBalance || isAdmin;
  const minBetSizeFromSettings = Math.min(...(settings.bet_sizes || [100]));
  
  if (!canSkipBalanceCheck && currentBalance < MINIMUM_BALANCE_REQUIRED) {
    await ctx.reply(
      `❌ ဘော့စတင်ရန် လက်ကျန်ငွေ မလုံလောက်ပါ။\n\n` +
      `💰 လက်ရှိလက်ကျန်ငွေ: ${currentBalance.toFixed(2)} Ks\n` +
      `🎯 လိုအပ်သောအနည်းဆုံးငွေ: ${MINIMUM_BALANCE_REQUIRED.toLocaleString()} Ks\n` +
      `📉 လိုနေသည့်ပမာဏ: ${(MINIMUM_BALANCE_REQUIRED - currentBalance).toFixed(2)} Ks\n\n` +
      `📌 ကျေးဇူးပြု၍ အနည်းဆုံး ${MINIMUM_BALANCE_REQUIRED.toLocaleString()} Ks ပြည့်အောင် ငွေဖြည့်ပါ။`
    );
    settings.running = false;
    return;
  }
  
  if (canSkipBalanceCheck && currentBalance < minBetSizeFromSettings) {
    await ctx.reply(
      `⚠️ Low Balance Warning!\n\n` +
      `💰 လက်ရှိလက်ကျန်ငွေ: ${currentBalance.toFixed(2)} Ks\n` +
      `💵 အနည်းဆုံးလောင်းကြေး: ${minBetSizeFromSettings} Ks\n` +
      `⚡ ${isAdmin ? 'Admin' : 'Bypass'} Mode: Active (No 30,000 Ks requirement)\n\n` +
      `📌 ငွေထပ်မဖြည့်နိုင်သေးရင် ဆက်ကစားနိုင်ပါသည်။`
    );
    
  }
  
  userWaitingForResult[userId] = false;
  delete userPendingBets[userId];
  delete userSkippedBets[userId];
  delete userShouldSkipNext[userId];
  delete userSLSkipWaitingForWin[userId];
  delete userDelayUntil[userId];
  
  resetSkipPeriods(userId);
  
  if (!userStats[userId]) {
    userStats[userId] = {};
  }

  if (settings.virtual_mode) {
    if (settings.admin_virtual_mode) {
      if (!userStats[userId].admin_virtual_balance) {
        userStats[userId].admin_virtual_balance = 0;
        userStats[userId].admin_start_balance = 0;
      }
    } else {
      userStats[userId].virtual_balance = VIRTUAL_BALANCE;
    }
  } else {
    userStats[userId].profit = 0.0;
  }
  
  settings.original_martin_index = settings.martin_index || 0;
  settings.original_dalembert_units = settings.original_dalembert_units || 1;
  settings.original_custom_index = settings.original_custom_index || 0;
  
  settings.martin_index = settings.original_martin_index || 0;
  settings.dalembert_units = settings.original_dalembert_units || 1;
  settings.custom_index = settings.original_custom_index || 0;
  settings.consecutive_losses = 0;
  
  settings.lose_sl_consecutive_losses = 0;
  settings.lose_sl_skip_count = 0;
  settings.lose_sl_skipped_count = 0;
  settings.lose_sl_active = false;
  
  settings.consecutive_loss_limit = settings.consecutive_loss_limit || null;
  settings.consecutive_loss_count = 0;
  settings.alert_sent_for_this_streak = false;
  
  settings.running = true;
  settings.last_issue = null;
  settings.consecutive_errors = 0;
  settings.current_layer = 0;
  settings.skip_betting = false;
  
  userShouldSkipNext[userId] = false;
  delete userSLSkipWaitingForWin[userId];
  
  const entryLayer = settings.layer_limit || 1;
  if (entryLayer === 2) {
    settings.entry_layer_state = { 
      waiting_for_loses: true, 
      consecutive_loses: 0,
      required_loses: 1, 
      real_betting_started: false
    };
  } else if (entryLayer === 3) {
    settings.entry_layer_state = { 
      waiting_for_loses: true, 
      consecutive_loses: 0,
      required_loses: 2, 
      real_betting_started: false
    };
  } else if (entryLayer >= 4 && entryLayer <= 9) {
    settings.entry_layer_state = { 
      waiting_for_loses: true, 
      consecutive_loses: 0,
      required_loses: entryLayer - 1,  
      real_betting_started: false
    };
  }
  
  if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL") {
    userResultHistory[userId] = [];
    settings.bs_wait_active = false;
    settings.bs_wait_remaining = 0;
  }
  
  if (settings.strategy === "DREAM") {
    settings.dream_state = {
      first_bet: true,
      current_pattern: "",
      current_index: 0
    };
    logging.info(`DREAM strategy initialized for user ${userId}`);
  }
  
  if (settings.strategy === "ALINKAR" || settings.strategy === "MAY_BARANI") {
    userResultHistory[userId] = userResultHistory[userId] || [];
    logging.info(`${settings.strategy} strategy initialized for user ${userId}`);
  }

  delete userSkippedBets[userId];
  userShouldSkipNext[userId] = false;
  delete userSLSkipWaitingForWin[userId];
  
  userWaitingForResult[userId] = false;
  
  let startMessage = `✅ BOT START\n\n`;
  startMessage += `💠 Balance: ${currentBalance} Ks\n`;
  startMessage += `🎮 Mode: ${settings.admin_virtual_mode ? 'Real' : (settings.virtual_mode ? 'Virtual' : 'Real')}\n\n`;
  startMessage += `🎯 Profit Target: ${settings.target_profit ? settings.target_profit + ' Ks' : '0 Ks'}\n`;
  startMessage += `🛡️ Stop Loss: ${settings.stop_loss ? settings.stop_loss + ' Ks' : '0 Ks'}\n\n`;
  
  if (settings.consecutive_loss_limit && settings.consecutive_loss_limit > 0) {
    startMessage += `⚠️ Loss Alert: ${settings.consecutive_loss_limit}x consecutive losses\n`;
  }
  
  if (settings.betting_strategy) {
    let bettingStrategyDisplay = "";
    switch (settings.betting_strategy) {
      case "Martingale":
        bettingStrategyDisplay = "Martingale";
        break;
      case "Anti-Martingale":
        bettingStrategyDisplay = "Anti-Martingale";
        break;
      case "D'Alembert":
        bettingStrategyDisplay = "D'Alembert";
        break;
      case "Custom":
        bettingStrategyDisplay = "Custom";
        break;
      default:
        bettingStrategyDisplay = settings.betting_strategy;
    }
    startMessage += `🚀 Betting Strategy: ${bettingStrategyDisplay}\n`;
  }
  
  if (settings.strategy) {
    let strategyDisplay = "";
    switch (settings.strategy) {
      case "CHAT_GPT":
        strategyDisplay = "Chat GPT Pattern Recognition";
        break;
      case "TREND_FOLLOW":
        strategyDisplay = "Trend Follow";
        if (settings.bs_wait_count > 0) {
          strategyDisplay += ` (BS/SB Wait: ${settings.bs_wait_count})`;
        }
        break;
      case "BS_ORDER":
        strategyDisplay = "BS Order";
        break;
      case "COLOR_TREND":
        strategyDisplay = "Color Trend";
        break;
      case "CHANNEL_SIGNAL":
        const channelName = savedChannels.find(ch => ch.id === settings.target_channel_id)?.name || "Unknown";
        strategyDisplay = `📡 Channel (${channelName})`;
        break;
      default:
        strategyDisplay = settings.strategy;
    }
    startMessage += `🧠 Strategy: ${strategyDisplay}\n`;
  }
  
  await ctx.reply(startMessage, { disable_notification: true });
  
  try {
    while (settings.running) {
      updateUserActivity(userId);
      
      if (userDelayUntil[userId] && Date.now() < userDelayUntil[userId]) {
        const remainingDelay = userDelayUntil[userId] - Date.now();
        if (remainingDelay > 0) {
          logging.info(`Waiting ${Math.ceil(remainingDelay/1000)} seconds before next bet for user ${userId}`);
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, remainingDelay)));
          continue;
        } else {
          delete userDelayUntil[userId];
        }
      }
      
      if (userWaitingForResult[userId]) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      if (userSkipResultWait[userId]) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
    
      if (!settings.virtual_mode) {
       
        if (!await ensureValidSessionMain(userId, bot)) {
          
          logging.warning(`Session expired during betting for user ${userId}, attempting auto-login...`);
          const autoLoginSuccess = await robustAutoLogin(userId, bot);
          if (!autoLoginSuccess) {
            settings.running = false;
            await ctx.reply("❌ Session expired. Auto-login failed. Please login again.", makeMainKeyboard(false, userId));
            break;
          }
        
          session = userSessions[userId];
          logging.info(`User ${userId} - Session updated after auto-login`);
        } else {
         
          const latestSession = userSessions[userId];
          if (latestSession && latestSession.token !== session.token) {
            session = latestSession;
            logging.info(`User ${userId} - Session updated with new token`);
          }
        }
      }
      
      if (settings.virtual_mode) {
        if (settings.admin_virtual_mode) {
          currentBalance = userStats[userId]?.admin_virtual_balance || 0;
        } else {
          currentBalance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
        }
      } else {
        try {
          
          if (!await ensureValidSessionMain(userId, bot)) {
            logging.warning(`Session expired during betting for user ${userId}, attempting auto-login...`);
            const autoLoginSuccess = await robustAutoLogin(userId, bot);
            if (!autoLoginSuccess) {
              settings.running = false;
              await ctx.reply("❌ Session expired. Auto-login failed. Please login again.", makeMainKeyboard(false, userId));
              break;
            }
          
            session = userSessions[userId]; 
            logging.info(`User ${userId} - Session updated after balance check auto-login`);
          } else {
            
            const latestSession = userSessions[userId];
            if (latestSession && latestSession.token !== session.token) {
              session = latestSession;
              logging.info(`User ${userId} - Session updated with new token during balance check`);
            }
          }
          
          const balanceResult = await safeExecute(userId, () => getBalance(session, parseInt(userId)), null);
          if (balanceResult !== null) {
            currentBalance = balanceResult;
          } else {
            logging.warning(`Balance returned null for user ${userId}, attempting auto-login...`);
            const autoLoginSuccess = await robustAutoLogin(userId, bot);
            if (autoLoginSuccess) {
            
              session = userSessions[userId];
              const retryBalance = await safeExecute(userId, () => getBalance(session, parseInt(userId)), null);
              if (retryBalance !== null) {
                currentBalance = retryBalance;
              } else {
                if (currentBalance === null) {
                  currentBalance = userStats[userId].start_balance || 0;
                }
              }
            } else {
              if (currentBalance === null) {
                currentBalance = userStats[userId].start_balance || 0;
              }
            }
          }
        } catch (error) {
          logging.error(`Balance check failed: ${error.message}`);
          if (currentBalance === null) {
            currentBalance = userStats[userId].start_balance || 0;
          }
        }
      }
      
      if (currentBalance === null) {
        logging.error(`Current balance is null for user ${userId}, attempting to recover`);
        let recovered = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            
            if (!await ensureValidSessionMain(userId, bot)) {
              const autoLoginSuccess = await robustAutoLogin(userId, bot);
              if (!autoLoginSuccess) {
                settings.running = false;
                await ctx.reply("❌ Session expired. Auto-login failed. Please login again.", makeMainKeyboard(false, userId));
                break;
              }
            
              session = userSessions[userId];
            } else {
             
              const latestSession = userSessions[userId];
              if (latestSession && latestSession.token !== session.token) {
                session = latestSession;
              }
            }
            
            const balanceResult = await safeExecute(userId, () => getBalance(session, parseInt(userId)), null);
            if (balanceResult !== null) {
              currentBalance = balanceResult;
              recovered = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            logging.error(`Balance recovery attempt ${attempt + 1} failed: ${error.message}`);
          }
        }
        
        if (!recovered) {
          await ctx.reply("❌ Failed to recover balance. Stopping bot to prevent errors.", makeMainKeyboard(true, userId));
          settings.running = false;
          break;
        }
      }
      
      const betSizes = settings.bet_sizes || [100];
      if (!betSizes.length) {
        await ctx.reply("Bot is not working at the moment because some Bot Settings are still to be configured !", makeMainKeyboard(true, userId));
        settings.running = false;
        break;
      }
      
      const minBetSize = Math.min(...betSizes);
      if (currentBalance < minBetSize) {
        const message = `❌ Insufficient balance!\n` +
                        `Current Balance: ${currentBalance.toFixed(2)} Ks\n` +
                        `Minimum Bet Required: ${minBetSize} Ks\n` +
                        `Please add funds to continue betting.`;
        await ctx.reply(message, makeMainKeyboard(true, userId));
        settings.running = false;
        break;
      }
      
      const balanceWarningThreshold = minBetSize * 3;
      const now = Date.now();
      const lastWarning = userBalanceWarnings[userId] || 0;
      
      if (currentBalance < balanceWarningThreshold && currentBalance >= minBetSize && (now - lastWarning > 60000)) {
        const warningMessage = `⚠️ Balance Warning!\n` +
                              `⛔ Current Balance: ${currentBalance.toFixed(2)} Ks\n` +
                              `❓ Minimum Bet: ${minBetSize} Ks\n` +
                              `✅ Consider adding funds soon to avoid interruption.`;
        await ctx.reply(warningMessage);
        userBalanceWarnings[userId] = now;
      }
      
      if (currentBalance < minBetSize) {
        const message = `❌ Insufficient balance for next bet!\n` +
                        `Current Balance: ${currentBalance.toFixed(2)} Ks\n` +
                        `Minimum Bet Required: ${minBetSize} Ks\n` +
                        `Please add funds to continue betting.`;
        await ctx.reply(message, makeMainKeyboard(true, userId));
        settings.running = false;
        break;
      }
      
      
      if (!settings.virtual_mode) {
        const latestSession = userSessions[userId];
        if (latestSession) {
          if (latestSession.token !== session.token) {
            session = latestSession;
            logging.info(`User ${userId} - Session updated before API call`);
          }
        } else {
          logging.error(`No session available for user ${userId} before API call`);
          settings.running = false;
          await ctx.reply("❌ Session lost. Please login again.", makeMainKeyboard(false, userId));
          break;
        }
      }
      
      let issueRes;
      try {
        issueRes = await safeExecute(userId, () => getGameIssueRequest(session, gameType), null);
        if (!issueRes || issueRes.code !== 0) {
          settings.consecutive_errors++;
          if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS_BET) {
            await ctx.reply(`Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS_BET}). Stopping bot`);
            settings.running = false;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      } catch (error) {
        logging.error(`Error getting issue: ${error.message}`);
        settings.consecutive_errors++;
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS_BET) {
          await ctx.reply(`Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS_BET}). Stopping bot`);
          settings.running = false;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      settings.consecutive_errors = 0;
      settings.breaker_data_gathering_count = 0;
      
      const data = issueRes.data || {};
      let currentIssue;
      
      if (gameType === "TRX") {
        currentIssue = data.predraw?.issueNumber;
      } else {
        currentIssue = data.issueNumber;
      }
      
      if (!currentIssue || currentIssue === settings.last_issue) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      let ch;
      let shouldSkipForStrategy = false;
      let skipReason = "";
      let signalInfo = "";
      
      if (settings.strategy === "BS_ORDER") {
        const prediction = await safeExecute(userId, () => getBSOrderPrediction(userId, gameType), null);
        if (prediction && prediction.result) {
          ch = prediction.result;
          shouldSkipForStrategy = prediction.shouldSkip || false;
          if (shouldSkipForStrategy) {
            skipReason = "BS Order Skip";
          }
        } else {
          ch = Math.random() < 0.5 ? 'B' : 'S';
        }
      } else if (settings.strategy === "CHANNEL_SIGNAL") {
        const targetId = settings.target_channel_id;
        
        if (targetId) {
          try {
            const currentIssueShort = formatPeriod(currentIssue);
            logging.info(`User ${userId} - Looking for signal for period: ${currentIssueShort}`);
            
            const MAX_WAIT_TIME = 15000; 
            const CHECK_INTERVAL = 1000; 
            const startWaitTime = Date.now();
            let signalFound = false;
            
            while (Date.now() - startWaitTime < MAX_WAIT_TIME && settings.running) {
              const signal = channelSignals[targetId];
              
              if (signal && signal.valid) {
                const signalPeriodShort = signal.period ? signal.period.toString().slice(-5) : signal.period;
                const signalAge = Date.now() - signal.receivedAt;
                
                if (signalPeriodShort === currentIssueShort) {
                  ch = signal.prediction;
                  shouldSkipForStrategy = false;
                  skipReason = "";
                  signalInfo = `Source: ${signal.name || 'Channel'} (${Math.floor(signalAge / 1000)}s ago)`;
                  signalFound = true;
                  
                  logging.info(`User ${userId} - Signal found for period ${currentIssueShort}: ${ch} (Age: ${Math.floor(signalAge / 1000)}s)`);
                  break;
                } else {
                  logging.debug(`User ${userId} - Signal period mismatch: ${signalPeriodShort} vs ${currentIssueShort}`);
                }
              }
              
              await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
            }
            
            if (!signalFound) {
              ch = Math.random() < 0.5 ? 'B' : 'S';
              shouldSkipForStrategy = true;
              skipReason = "📡 No Signal (15s timeout)";
              signalInfo = "";
              
              logging.info(`User ${userId} - No signal found for period ${currentIssueShort} within 15 seconds. Skipping.`);
            }
            
          } catch (error) {
            logging.error(`Channel signal error for user ${userId}: ${error.message}`);
            ch = Math.random() < 0.5 ? 'B' : 'S';
            shouldSkipForStrategy = true;
            skipReason = "Error getting signal";
          }
        } else {
          shouldSkipForStrategy = true;
          skipReason = "⚠️ Please select a channel from Strategy Menu";
        }
      }
      
      else if (settings.strategy === "CHAT_GPT") {
        const prediction = await safeExecute(userId, () => getChatGPTPrediction(userId), null);
        if (prediction && prediction.result) {
          ch = prediction.result;
          shouldSkipForStrategy = prediction.shouldSkip || false;
          if (shouldSkipForStrategy) {
            skipReason = "ChatGPT Skip";
          }
        } else {
          ch = Math.random() < 0.5 ? 'B' : 'S';
        }
      } else if (settings.strategy === "TREND_FOLLOW") {
        const bsWaitCount = settings.bs_wait_count || 0;
        
        let shouldSkipForTrend = false;
        let skipReasonTrend = "";
        
        if (settings.bs_wait_active) {
          shouldSkipForTrend = true;
          skipReasonTrend = `BS/SB Wait Active`;
        } else if (bsWaitCount > 0 && userResultHistory[userId] && userResultHistory[userId].length >= bsWaitCount * 2) {
          const bsPattern = "BS".repeat(bsWaitCount);
          const sbPattern = "SB".repeat(bsWaitCount);
          const hasBSPattern = checkPatternInHistory(userResultHistory[userId], bsPattern);
          const hasSBPattern = checkPatternInHistory(userResultHistory[userId], sbPattern);
          
          if (hasBSPattern || hasSBPattern) {
            shouldSkipForTrend = true;
            skipReasonTrend = `BS/SB Wait ${bsWaitCount}`;
            settings.bs_wait_active = true;
            settings.bs_wait_remaining = bsWaitCount;
          }
        }
        
        if (userResultHistory[userId] && userResultHistory[userId].length > 0) {
          const lastResult = userResultHistory[userId][userResultHistory[userId].length - 1];
          ch = lastResult;
        } else {
          ch = Math.random() < 0.5 ? 'B' : 'S';
        }
        
        if (shouldSkipForTrend) {
          userShouldSkipNext[userId] = true;
          settings.trend_skip_reason = skipReasonTrend;
          
          if (settings.bs_wait_active && settings.bs_wait_remaining > 0) {
            settings.bs_wait_remaining--;
            if (settings.bs_wait_remaining === 0) {
              settings.bs_wait_active = false;
            }
          }
          shouldSkipForStrategy = true;
          skipReason = skipReasonTrend;
        } else {
          userShouldSkipNext[userId] = false;
          delete settings.trend_skip_reason;
        }
      } else if (settings.strategy === "BREAKER") {
        const prediction = await safeExecute(userId, () => getBreakerPrediction(userId, gameType), null);
  
        if (prediction) {
          if (prediction.shouldSkip) {
            shouldSkipForStrategy = true;
            skipReason = prediction.skipReason || "Breaker Skip";
            
           if (!userSkippedBets[userId]) userSkippedBets[userId] = {};
           userSkippedBets[userId][currentIssue] = [null, settings.virtual_mode, skipReason];
           
           const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
           let betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)}\n━━━━━━━━━━━━━━━━━━━\n🚨 Order : SKIPPED => ${skipReason}\n━━━━━━━━━━━━━━━━━━━`;
            
           await ctx.reply(betMsg, { disable_notification: true });
           
            settings.last_issue = currentIssue;
           await new Promise(resolve => setTimeout(resolve, 1000));
            continue; 
         } else {
           ch = prediction.result;
          }
       } else {
          shouldSkipForStrategy = true;
          skipReason = "Breaker Error";
       }
      } else if (settings.strategy === "COLOR_TREND") {
        const colorPrediction = await safeExecute(userId, () => getColorPrediction(userId), null);
        if (colorPrediction && colorPrediction.result) {
          ch = colorPrediction.result;
        } else {
          ch = 'G';
        }
      }
      
      else {
        if (userResultHistory[userId] && userResultHistory[userId].length > 0) {
          const lastResult = userResultHistory[userId][userResultHistory[userId].length - 1];
          ch = lastResult;
        } else {
          ch = Math.random() < 0.5 ? 'B' : 'S';
        }
      }
      
      if (betType === "COLOR") {
        const colorPrediction = await safeExecute(userId, () => getColorPrediction(userId), null);
        if (colorPrediction && colorPrediction.result) {
          ch = colorPrediction.result;
        } else {
          ch = 'G';
        }
      }
      
      const direction = settings.bet_direction || "STRAIGHT";
      const originalCh = ch;
      
      if (direction === "REVERSE") {
        ch = applyBetDirection(ch, betType, direction);
        logging.info(`User ${userId} - Direction: REVERSE, Original: ${originalCh}, Reversed: ${ch}`);
        
        if (signalInfo) {
          signalInfo = `📉 REVERSED: ${signalInfo}`;
        }
        
        if (skipReason && skipReason.includes("Order :")) {
          skipReason = skipReason.replace(`Order : ${originalCh === 'B' ? 'BIG' : 'SMALL'}`, 
                                           `Order : ${ch === 'B' ? 'BIG' : 'SMALL'} (Reversed)`);
        }
      } else {
        logging.info(`User ${userId} - Direction: STRAIGHT, Prediction: ${ch}`);
      }
      
      const selectType = getSelectMap(betType)[ch];
      
      if (selectType === undefined) {
        settings.consecutive_errors++;
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS_BET) {
          await ctx.reply(`Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS_BET}). Stopping bot`);
          settings.running = false;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      let betMsg;
      let shouldSkip = false;
      
      if (shouldSkipForStrategy) {
        shouldSkip = true;
        if (!skipReason) {
          skipReason = "SKIP Please Wait";
        }
      }

      const loseSLSkip = checkLoseSLSkip(userId, settings);
      if (loseSLSkip.shouldSkip) {
        shouldSkip = true;
        skipReason = loseSLSkip.reason;
        
        const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
        if (betType === "COLOR") {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)}\n━━━━━━━━━━━━━━━━━━━\n💀 Lose SL: ${getColorName(ch)} => ${skipReason} (${loseSLSkip.currentSkip}/${loseSLSkip.skipCount})\n━━━━━━━━━━━━━━━━━━━`;
        } else {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)}\n━━━━━━━━━━━━━━━━━━━\n💀 Lose SL: ${ch === 'B' ? 'BIG' : 'SMALL'} => ${skipReason} (${loseSLSkip.currentSkip}/${loseSLSkip.skipCount})\n━━━━━━━━━━━━━━━━━━━`;
        }
        
        if (!userSkippedBets[userId]) {
          userSkippedBets[userId] = {};
        }
        userSkippedBets[userId][currentIssue] = [ch, settings.virtual_mode, skipReason, loseSLSkip.skipCount];
        
        await ctx.reply(betMsg, { disable_notification: true });
        
        userSkipResultWait[userId] = currentIssue;
        
        let resultAvailable = false;
        let waitAttempts = 0;
        const maxWaitAttempts = 60;
        
        while (!resultAvailable && waitAttempts < maxWaitAttempts && settings.running) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          if (!userSkipResultWait[userId] || userSkipResultWait[userId] !== currentIssue) {
            resultAvailable = true;
          }
          
          waitAttempts++;
        }
        
        if (!resultAvailable) {
          if (userSkipResultWait[userId] === currentIssue) {
            delete userSkipResultWait[userId];
          }
        }
        
        settings.last_issue = currentIssue;
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      const entryLayerLimit = settings.layer_limit || 1;
      if (entryLayerLimit >= 2 && entryLayerLimit <= 9) {
        if (settings.entry_layer_state && settings.entry_layer_state.waiting_for_loses) {
          shouldSkip = true;
          skipReason = `Entry Layer ${entryLayerLimit} (${settings.entry_layer_state.consecutive_loses || 0}/${settings.entry_layer_state.required_loses})`;
          
          if (!userSkippedBets[userId]) {
            userSkippedBets[userId] = {};
          }
          userSkippedBets[userId][currentIssue] = [ch, settings.virtual_mode, skipReason];
          
          const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
          if (betType === "COLOR") {
            betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)}\n━━━━━━━━━━━━━━━━━━━\n🚨 Order : ${getColorName(ch)} => ${skipReason}\n━━━━━━━━━━━━━━━━━━━`;
          } else {
            betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)}\n━━━━━━━━━━━━━━━━━━━\n🚨 Order : ${ch === 'B' ? 'BIG' : 'SMALL'} => ${skipReason}\n━━━━━━━━━━━━━━━━━━━`;
          }
          
          await ctx.reply(betMsg, { disable_notification: true });
          
          userSkipResultWait[userId] = currentIssue;
          
          let resultAvailable = false;
          let waitAttempts = 0;
          const maxWaitAttempts = 60;
          
          while (!resultAvailable && waitAttempts < maxWaitAttempts && settings.running) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            if (!userSkipResultWait[userId] || userSkipResultWait[userId] !== currentIssue) {
              resultAvailable = true;
            }
            
            waitAttempts++;
          }
          
          if (!resultAvailable) {
            if (userSkipResultWait[userId] === currentIssue) {
              delete userSkipResultWait[userId];
            }
          }
          
          settings.last_issue = currentIssue;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
      
      if (settings.sl_layer && settings.consecutive_losses >= settings.sl_layer) {
        shouldSkip = true;
        if (!skipReason) {
          skipReason = `SL Layer (${settings.sl_layer})`;
        }
        userSLSkipWaitingForWin[userId] = true;
      }
      
      if (userSLSkipWaitingForWin[userId] && !shouldSkip) {
        delete userSLSkipWaitingForWin[userId];
        userShouldSkipNext[userId] = false;
        logging.info(`SL Skip reset - proceeding with normal betting strategy`);
      }
      
      if (settings.strategy === "TREND_FOLLOW" && userShouldSkipNext[userId]) {
        shouldSkip = true;
        if (!skipReason) {
          skipReason = settings.trend_skip_reason || "Skipped";
        }
      }
      
      if (shouldSkip) {
        const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
        
        let directionText = "";
        if (direction === "REVERSE") {
          directionText = `\n📉 Direction: Reverse (${originalCh} → ${ch})`;
        }
        
        if (betType === "COLOR") {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n` +
                   `🆔 Period: ${formatPeriod(currentIssue)}\n` +
                   `━━━━━━━━━━━━━━━━━━━\n` +
                   `🚨 Order : ${getColorName(ch)}${directionText} => ${skipReason}\n` +
                   `━━━━━━━━━━━━━━━━━━━`;
        } else {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n` +
                   `🆔 Period :${formatPeriod(currentIssue)}\n` +
                   `━━━━━━━━━━━━━━━━━━━\n` +
                   `🚨 Order : ${ch === 'B' ? 'BIG' : 'SMALL'}${directionText} => ${skipReason}\n` +
                   `━━━━━━━━━━━━━━━━━━━`;
        }

        if (!userSkippedBets[userId]) {
          userSkippedBets[userId] = {};
        }
        
        let skipCount = 0;
        if (settings.strategy === "TREND_FOLLOW" && settings.bs_wait_count > 0) {
          skipCount = settings.bs_wait_count - (settings.bs_wait_remaining || 0);
        }
        
        if (skipReason.includes("Period Not Match")) {
          betMsg += `\n\n📡 Skipping: Signal period doesn't match current period`;
        }
        
        userSkippedBets[userId][currentIssue] = [ch, settings.virtual_mode, skipReason, skipCount];
        
        userSkipResultWait[userId] = currentIssue;
        
        await ctx.reply(betMsg, { disable_notification: true });
        
        let resultAvailable = false;
        let waitAttempts = 0;
        const maxWaitAttempts = 60;
        
        while (!resultAvailable && waitAttempts < maxWaitAttempts && settings.running) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          if (!userSkipResultWait[userId] || userSkipResultWait[userId] !== currentIssue) {
            resultAvailable = true;
          }
          
          waitAttempts++;
        }
        
        if (!resultAvailable) {
          if (userSkipResultWait[userId] === currentIssue) {
            delete userSkipResultWait[userId];
          }
        }
        
        settings.last_issue = currentIssue;
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      } else {
        let desiredAmount;
        try {
          desiredAmount = calculateBetAmount(settings, currentBalance);
        } catch (error) {
          await ctx.reply(
                        `❌ ${error.message}\n` +
            `Please stop bot and set Bet Size again.`,
            makeMainKeyboard(true, userId)
          );
          settings.running = false;
          break;
        }
        
        const { unitAmount, betCount, actualAmount } = computeBetDetails(desiredAmount);
        
        if (actualAmount === 0) {
          await ctx.reply(
            `❌ Invalid bet amount: ${desiredAmount} Ks\n` +
            `Minimum bet amount is ${unitAmount} Ks\n` +
            `Please increase your bet size.`,
            makeMainKeyboard(true, userId)
          );
          settings.running = false;
          break;
        }
        
        if (currentBalance < actualAmount) {
          const message = `❌ Insufficient balance for next bet!\n` +
                          `Current Balance: ${currentBalance.toFixed(2)} Ks\n` +
                          `Required Bet Amount: ${actualAmount.toFixed(2)} Ks\n` +
                          `Please add funds to continue betting.`;
          await ctx.reply(message, makeMainKeyboard(true, userId));
          settings.running = false;
          break;
        }
        
        
        if (!settings.virtual_mode) {
          const latestSession = userSessions[userId];
          if (latestSession) {
            if (latestSession.token !== session.token) {
              session = latestSession;
              logging.info(`User ${userId} - Session updated before placing bet`);
            }
          } else {
            logging.error(`No session available for user ${userId} before placing bet`);
            settings.running = false;
            await ctx.reply("❌ Session lost. Please login again.", makeMainKeyboard(false, userId));
            break;
          }
        }
        
        const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);

        let directionInfo = "";
        if (direction === "REVERSE") {
          directionInfo = `\n📉 Direction: Reverse (${originalCh} → ${ch})`;
        }

        let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");

        if (betType === "COLOR") {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n` +
                   `🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n` +
                   `━━━━━━━━━━━━━━━━━━━\n` +
                   `🎲 Order : ${getColorName(ch)}${directionInfo} => ${actualAmount} Ks\n` +
                   `━━━━━━━━━━━━━━━━━━━`;
        } else {
          betMsg = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n` +
                   `🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n` +
                   `━━━━━━━━━━━━━━━━━━━\n` +
                   `🎲 Order : ${ch === 'B' ? 'BIG' : 'SMALL'}${directionInfo} => ${actualAmount} Ks\n` +
                   `━━━━━━━━━━━━━━━━━━━`;
        }
        
        await ctx.reply(betMsg, { disable_notification: true });
        
        if (settings.virtual_mode) {
          if (!userPendingBets[userId]) {
            userPendingBets[userId] = {};
          }
          userPendingBets[userId][currentIssue] = [ch, actualAmount, true];
          userWaitingForResult[userId] = true;
        } else {
        
          const latestSession = userSessions[userId];
          if (latestSession) {
            if (latestSession.token !== session.token) {
              session = latestSession;
              logging.info(`User ${userId} - Session updated before bet placement`);
            }
          } else {
            logging.error(`No session available for user ${userId} before placing bet`);
            settings.running = false;
            await ctx.reply("❌ Session lost. Please login again.", makeMainKeyboard(false, userId));
            break;
          }
          
          const betResp = await safeExecute(userId, () => placeBetRequest(session, currentIssue, selectType, unitAmount, betCount, gameType, parseInt(userId)), null);
          
          if (!betResp || betResp.error || betResp.code !== 0) {
            await ctx.reply(`Bet error:❌လက်ရှို Period ကို ပိတ်ပြီးသားဖြစ်ပါတယ်။
🔄 ပြန်လည်ကြိုးစားနေပါသည်...\n ${betResp?.msg || betResp?.error || 'Unknown error'}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          
          if (!userPendingBets[userId]) {
            userPendingBets[userId] = {};
          }
          userPendingBets[userId][currentIssue] = [ch, actualAmount, false];
          userWaitingForResult[userId] = true;
        }
      }
      
      settings.last_issue = currentIssue;
      saveUserSettings();
      
      const botStopped = await safeExecute(userId, () => checkProfitAndStopLoss(userId, bot), false);
      if (botStopped) {
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logging.error(`Betting worker error for user ${userId}: ${error.message}`);
    await ctx.reply(`Betting error: ${error.message}. Stopping...`);
    settings.running = false;
  } finally {
    settings.running = false;
    delete userWaitingForResult[userId];
    delete userShouldSkipNext[userId];
    delete userBalanceWarnings[userId];
    delete userSkipResultWait[userId];
    delete userSLSkipWaitingForWin[userId];
    delete userDelayUntil[userId]; 
    delete settings.trend_skip_reason;
    resetSkipPeriods(userId);
    
    if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL") {
      delete userResultHistory[userId];
      settings.bs_wait_active = false;
    }
    
    if (settings.strategy === "DREAM") {
      delete settings.dream_state;
    }
    
    settings.original_martin_index = 0;
    settings.original_dalembert_units = 1;
    settings.original_custom_index = 0;
    
    settings.martin_index = 0;
    settings.dalembert_units = 1;
    settings.custom_index = 0;
    
    settings.lose_sl_consecutive_losses = 0;
    settings.lose_sl_skip_count = 0;
    settings.lose_sl_skipped_count = 0;
    settings.lose_sl_active = false;
    
    settings.consecutive_loss_count = 0;
    settings.alert_sent_for_this_streak = false;
    
    if (!userStopInitiated[userId]) {
      let totalProfit = 0;
      let balanceText = "";
      let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");
      
      if (settings.virtual_mode) {
        if (settings.admin_virtual_mode) {
          totalProfit = (userStats[userId]?.admin_virtual_balance || 0) - (userStats[userId]?.admin_start_balance || 0);
          balanceText = `Real Balance: ${(userStats[userId]?.admin_virtual_balance || 0).toFixed(2)} Ks\n`;
        } else {
          totalProfit = (userStats[userId]?.virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE;
          balanceText = `Virtual Balance: ${(userStats[userId]?.virtual_balance || VIRTUAL_BALANCE).toFixed(2)} Ks\n`;
        }
      } else {
        totalProfit = userStats[userId]?.profit || 0;
        try {
          const finalBalance = await safeExecute(userId, () => getBalance(session, userId), 0);
          balanceText = `💰 Final Balance: ${finalBalance?.toFixed(2) || '0.00'} Ks\n`;
        } catch (error) {
          balanceText = "Final Balance: Unknown\n";
        }
      }
      
      let profitIndicator = "";
      if (totalProfit > 0) {
        profitIndicator = "+";
      } else if (totalProfit < 0) {
        profitIndicator = "-";
      } else {
        profitIndicator = "";
      }
      
      const message = `🚫 BOT STOPPED\n${balanceText}💰 Total Profit: ${profitIndicator}${Math.abs(totalProfit).toFixed(2)} Ks`;
      await ctx.reply(message, makeMainKeyboard(true, userId));
    }
    
    delete userStopInitiated[userId];
  }
}

// ========== KEYBOARD FUNCTIONS ==========

function makeMainKeyboard(loggedIn = false, userId = null) {
  if (!loggedIn) {
    return Markup.keyboard([["🔐 Login"]]).resize().oneTime(false);
  }
  
  const keyboard = [];
  
  if (userId && ADMIN_IDS.includes(userId)) {
    keyboard.push(["💰 Admin Balance" , "⚙️ Admin Panel"]);
  }
  
  keyboard.push(
    ["⚔️ Start","🔐 Login" ,"🛡️ Stop"],    
    ["🎲 WINGO/TRX", "🎮 Virtual/Real Mode"],
    ["💣 Bet_Size", "🚀 Anti/Martingale" ],
    ["🧠 Strategy","📊 Bet Direction"],
    ["🏹 Profit Target", "🔥 Stop Loss Limit"],
    ["🔄 Entry Layer", "💥 Bet_SL", "💀 Lose SL"], 
    ["📊 TRX Checker", "⚠️ Loss Alert Limit","🏁 Info"], 
    ["🎮 Manual Bet"]
  );
  
  return Markup.keyboard(keyboard).resize().oneTime(false);
}

function makeAdminKeyboard() {
  return Markup.keyboard([
    ["➕ Add User", "❌ Remove User"],
    ["➕ Add Bypass", "❌ Remove Bypass"], 
    ["📡 Add Channel", "🗑️ Remove Channel"],
    ["📋 Show All", "👥 User Stats"],
    ["🔄 Sync Website"],
    ["📢 Broadcast", "📊 Signals"],
    ["🔙 Back to Home"]
  ]).resize().oneTime(false);
}

function makeLoseSLKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("0 - Disabled", "lose_sl:0")],
    [Markup.button.callback("1", "lose_sl:1"), Markup.button.callback("2", "lose_sl:2"), Markup.button.callback("3", "lose_sl:3")],
    [Markup.button.callback("4", "lose_sl:4"), Markup.button.callback("5", "lose_sl:5"), Markup.button.callback("6", "lose_sl:6")],
    [Markup.button.callback("7", "lose_sl:7"), Markup.button.callback("8", "lose_sl:8"), Markup.button.callback("9", "lose_sl:9")],
    [Markup.button.callback("10", "lose_sl:10")]
  ]);
}

function makeDirectionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📊 Straight", "direction:STRAIGHT"),
      Markup.button.callback("📉 Reverse", "direction:REVERSE")
    ]
  ]);
}

function makeStrategyKeyboard(userId) {
  const settings = userSettings[userId] || {};
  const gameType = settings.game_type || "TRX";
  const betType = settings.bet_type || "BS";
  const buttons = [];
  
  if (gameType === "WINGO30S") {
    buttons.push([
      Markup.button.callback("🐯 TrendFollow V1", "strategy:TREND_FOLLOW")
    ]);
    buttons.push([
      Markup.button.callback("🛡️ Breaker", "strategy:BREAKER")
    ]);
    buttons.push([
      Markup.button.callback("🐷 BS-Order", "strategy:BS_ORDER")
    ]);
    buttons.push([
      Markup.button.callback("💭 DREAM", "strategy:DREAM"),
      Markup.button.callback("🚬 ALINKAR", "strategy:ALINKAR")
    ]);
    buttons.push([
      Markup.button.callback("🐰 MAY BARANI", "strategy:MAY_BARANI")
    ]);
  } else {
    if (betType === "COLOR") {
      buttons.push([
        Markup.button.callback("🎨 Color Trend", "strategy:COLOR_TREND")
      ]);
    } else {
      savedChannels.forEach(ch => {
        buttons.push([
          Markup.button.callback(`📡 ${ch.name}`, `strategy:CHANNEL_SIGNAL:${ch.id}`)
        ]);
      });
      buttons.push([
        Markup.button.callback("🐯 TrendFollow V1", "strategy:TREND_FOLLOW")
      ]);
      buttons.push([
        Markup.button.callback("🛡️ Breaker", "strategy:BREAKER")
      ]);
      buttons.push([
        Markup.button.callback("🐷 BS-Order", "strategy:BS_ORDER")
      ]);
      buttons.push([
        Markup.button.callback("💭 DREAM", "strategy:DREAM"),
        Markup.button.callback("🚬 ALINKAR", "strategy:ALINKAR")
      ]);
      buttons.push([
        Markup.button.callback("🐰 MAY BARANI", "strategy:MAY_BARANI")
      ]);
    }
  }
  
  return Markup.inlineKeyboard(buttons);
}

function makeWingoStrategyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🐯 TrendFollow V1", "strategy:TREND_FOLLOW")],
    [Markup.button.callback("🛡️ Breaker", "strategy:BREAKER")],
    [Markup.button.callback("🐷 BS-Order", "strategy:BS_ORDER")],
    [Markup.button.callback("💭 DREAM", "strategy:DREAM"), Markup.button.callback("🚬 ALINKAR", "strategy:ALINKAR")],
    [Markup.button.callback("🐰 MAY BARANI", "strategy:MAY_BARANI")]
  ]);
}

function makeBettingStrategyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Anti-Martingale", "betting_strategy:Anti-Martingale")],
    [Markup.button.callback("Martingale", "betting_strategy:Martingale")],
    [Markup.button.callback("D'Alembert", "betting_strategy:D'Alembert")]
  ]);
}

function makeGameTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("WINGO30S", "game_type:WINGO30S")],
    [Markup.button.callback("TRX", "game_type:TRX")]
  ]);
}

function makeBetTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Big/Small", "bet_type:BS")],
    [Markup.button.callback("Color", "bet_type:COLOR")]
  ]);
}

function makeEntryLayerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1 - Direct  For BET", "entry_layer:1")],
    [Markup.button.callback("2 - Wait for 1 Lose", "entry_layer:2")],
    [Markup.button.callback("3 - Wait for 2 Loses", "entry_layer:3")],
    [Markup.button.callback("4 - Wait for 3 Loses", "entry_layer:4")],
    [Markup.button.callback("5 - Wait for 4 Loses", "entry_layer:5")],
    [Markup.button.callback("6 - Wait for 5 Loses", "entry_layer:6")],
    [Markup.button.callback("7 - Wait for 6 Loses", "entry_layer:7")],
    [Markup.button.callback("8 - Wait for 7 Loses", "entry_layer:8")],
    [Markup.button.callback("9 - Wait for 8 Loses", "entry_layer:9")]
  ]);
}

function makeLossAlertLimitKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("0 - Disabled", "loss_alert:0")],
        [Markup.button.callback("1", "loss_alert:1"), Markup.button.callback("2", "loss_alert:2"), Markup.button.callback("3", "loss_alert:3")],
        [Markup.button.callback("4", "loss_alert:4"), Markup.button.callback("5", "loss_alert:5"), Markup.button.callback("6", "loss_alert:6")],
        [Markup.button.callback("7", "loss_alert:7"), Markup.button.callback("8", "loss_alert:8"), Markup.button.callback("9", "loss_alert:9")],
        [Markup.button.callback("10", "loss_alert:10"), Markup.button.callback("15", "loss_alert:15"), Markup.button.callback("20", "loss_alert:20")]
    ]);
}

function makeSLLayerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("0 - Disabled", "sl_layer:0")],
    [Markup.button.callback("1", "sl_layer:1"), Markup.button.callback("2", "sl_layer:2"), Markup.button.callback("3", "sl_layer:3")],
    [Markup.button.callback("4", "sl_layer:4"), Markup.button.callback("5", "sl_layer:5"), Markup.button.callback("6", "sl_layer:6")],
    [Markup.button.callback("7", "sl_layer:7"), Markup.button.callback("8", "sl_layer:8"), Markup.button.callback("9", "sl_layer:9")]
  ]);
}

function makeModeSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🖥️ Virtual Mode", "mode:virtual")],
    [Markup.button.callback("💵 Real Mode", "mode:real")]
  ]);
}

function makeNumberPadKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("O (disable)", "number:0")],
    [Markup.button.callback("1", "number:1"), Markup.button.callback("2", "number:2"), Markup.button.callback("3", "number:3")],
    [Markup.button.callback("4", "number:4"), Markup.button.callback("5", "number:5"), Markup.button.callback("6", "number:6")],
    [Markup.button.callback("7", "number:7"), Markup.button.callback("8", "number:8"), Markup.button.callback("9", "number:9")]
  ]);
}

function makeStreakCountKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("3", "breaker_count:3"),
      Markup.button.callback("4", "breaker_count:4"),
      Markup.button.callback("5", "breaker_count:5")
    ],
    [
      Markup.button.callback("6", "breaker_count:6"),
      Markup.button.callback("7", "breaker_count:7"),
      Markup.button.callback("8", "breaker_count:8")
    ],
    [
      Markup.button.callback("9", "breaker_count:9")
    ]
  ]);
}

function makePlatformSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❤ 𝟔-𝐋𝐎𝐓𝐓𝐄𝐑𝐘", "platform:6LOTTERY")],
    [Markup.button.callback("💚 𝟟𝟟𝟟-𝐁𝐈𝐆𝐖𝐈", "platform:777BIGWIN")],
    [Markup.button.callback("💙 𝐂𝐤-𝐋𝐎𝐓𝐓𝐄𝐑𝐘", "platform:CKLOTTERY")]
  ]);
}

// ========== MANUAL BET KEYBOARDS ==========

function makeManualBetKeyboard() {
  return Markup.keyboard([
    ["💰 Balance", "📊 Live Results", "📝 Recent Bet"],
    ["🎯 Bet Big", "🎯 Bet Small"],
    ["🔴 Bet Red", "🟢 Bet Green", "🟣 Bet Violet"],
    ["🔙 Back to Home"]
  ]).resize().oneTime(false);
}

function makeManualGameTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎰 WINGO30S", "manual_game:WINGO30S")],
    [Markup.button.callback("💎 TRX", "manual_game:TRX")]
  ]);
}

function makeBetAmountKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("100", "manual_amount:100"),
      Markup.button.callback("1000", "manual_amount:1000")
      ],
      [
      Markup.button.callback("10000", "manual_amount:10000"),
      Markup.button.callback("100000", "manual_amount:100000")
    ],
    [
      Markup.button.callback("❌ Cancel", "manual_amount:cancel")
    ]
  ]);
}

function makeMultiplierKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("×1", "multiplier:1"),
      Markup.button.callback("×2", "multiplier:2"),
      Markup.button.callback("×5", "multiplier:5")
    ],
    [
      Markup.button.callback("×10", "multiplier:10"),
      Markup.button.callback("×20", "multiplier:20"),
      Markup.button.callback("×50", "multiplier:50")
    ],
    [
      Markup.button.callback("🔢 Custom", "multiplier:custom")
    ]
  ]);
}

function logoutUser(userId) {
  delete userSessions[userId];
  delete userGameInfo[userId];
  delete userLoginCredentials[userId];
  delete userSessionExpiry[userId];
  delete userTemp[userId];
  
  if (userSettings[userId]) {
    userSettings[userId].running = false;
  }
  
  delete userWaitingForResult[userId];
  delete userPendingBets[userId];
  delete userSkippedBets[userId];
  delete userShouldSkipNext[userId];
  delete userSLSkipWaitingForWin[userId];
  delete userDelayUntil[userId];
  delete userManualState[userId];
  delete userManualBetHistory[userId];
  delete userResultsMessages[userId];
  delete userLastResults[userId];
  
  logging.info(`User ${userId} logged out and all sessions cleared`);
}

async function checkUserAuthorized(ctx) {
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    await ctx.reply("Please Login ", makeMainKeyboard(false));
    return false;
  }
  if (!userSettings[userId]) {
    userSettings[userId] = getDefaultUserSettings();
    saveUserSettings();
  }
  return true;
}

async function cmdStartHandler(ctx) {
  const userId = ctx.from.id;
  
  addUserToAllList(userId);
  
  const result = await withCommandLock(userId, async () => {
    if (!userSettings[userId]) {
      userSettings[userId] = getDefaultUserSettings();
      saveUserSettings();
    }
    const loggedIn = !!userSessions[userId];
    
    await ctx.reply(
`◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆
       🌟 𝐇𝐄𝐋𝐋𝐎 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐀𝐋𝐋 𝐔𝐒𝐄𝐑
           🎰 𝐀𝐋𝐋 𝐋𝐎𝐓𝐓𝐄𝐑𝐘 𝐁𝐄𝐓 𝐁𝐎𝐓
                ⚡️ 𝐀𝐔𝐓𝐎 𝐒𝐘𝐒𝐓𝐄𝐌
◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆

✨ 𝗙𝗘𝗔𝗧𝗨𝗥𝗘𝗦 ✨
├─ 🎯 𝐀𝐮𝐭𝐨 𝐁𝐞𝐭
├─ 🤖 𝐁&𝐒 𝐀𝐥𝐠𝐨𝐫𝐢𝐭𝐡𝐦
└─ ⏳ 𝟐𝟒/𝟕 𝐀𝐜𝐭𝐢𝐯𝐞

├─ 🌐 𝟔-𝐋𝐎𝐓𝐓𝐄𝐑𝐘:
   https://www.6win999.com/#/register?invitationCode=32135987612
   
├─ 🌐 𝐂𝐊 𝐋𝐨𝐭𝐭𝐞𝐫𝐲:
   http://www.cklottery.tv/#/register?invitationCode=5811744750
   
├─ 🌐 𝟕𝟕𝟕 𝐁𝐢𝐠 𝐖𝐢𝐧:
   https://www.777bigwingame.club/#/register?invitationCode=38768103278
   
📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗜𝗡𝗙𝗢 📞
├─ 👑 𝐀𝐝𝐦𝐢𝐧: @usernamebob47

◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆
   🚀 𝐒𝐓𝐀𝐑𝐓: Click 🔐 𝐋𝐨𝐠𝐢𝐧`, 
      makeMainKeyboard(loggedIn, userId)
    );
    return true;
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdAllowHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length || !args[0].match(/^\d+$/)) {
      await ctx.reply("Usage: /allow {6lottery_id}", makeMainKeyboard(true, userId));
      return;
    }
    const bigwinId = parseInt(args[0]);
    if (allowed777bigwinIds.has(bigwinId)) {
      await ctx.reply(`User ${bigwinId} already added`, makeMainKeyboard(true, userId));
    } else {
      allowed777bigwinIds.add(bigwinId);
      saveAllowedUsers();
      await ctx.reply(`User ${bigwinId} added`, makeMainKeyboard(true, userId));
    }
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdRemoveHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length || !args[0].match(/^\d+$/)) {
      await ctx.reply("Usage: /remove {6lottery_id}", makeMainKeyboard(true, userId));
      return;
    }
    const bigwinId = parseInt(args[0]);
    if (!allowed777bigwinIds.has(bigwinId)) {
      await ctx.reply(`User ${bigwinId} not found`, makeMainKeyboard(true, userId));
    } else {
      allowed777bigwinIds.delete(bigwinId);
      saveAllowedUsers();
      await ctx.reply(`User ${bigwinId} removed`, makeMainKeyboard(true, userId));
    }
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdShowHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }
    
    const allowedIds = Array.from(allowed777bigwinIds);
    if (allowedIds.length === 0) {
      await ctx.reply("No users have been added yet.", makeMainKeyboard(true, userId));
      return;
    }
    
    let message = "🧔 User ID List\n\n";
    allowedIds.forEach((id, index) => {
      message += `${index + 1}. ${id}\n`;
    });
    
    message += `\nTotal: ${allowedIds.length} users`;
    await ctx.reply(message, makeMainKeyboard(true, userId));
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdSendHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }
    
    const messageText = ctx.message.text.substring(6).trim();
    if (!messageText) {
      await ctx.reply("Usage: /send (message)", makeMainKeyboard(true, userId));
      return;
    }
    
    const fullMessage = `🗞ADMIN ထံမှအကြောင်းစာ:\n\n${messageText}`;

    let successCount = 0;
    let failCount = 0;
    
    const uniqueUsers = new Set();
    
    allUsers.forEach(id => uniqueUsers.add(parseInt(id)));
    
    Object.keys(userSessions).forEach(id => uniqueUsers.add(parseInt(id)));
    
    logging.info(`Broadcast to ${uniqueUsers.size} unique users`);
    
    for (const userIdStr of uniqueUsers) {
      try {
        await sendMessageWithRateLimit(ctx.telegram, userIdStr, fullMessage);
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        logging.error(`Failed to send broadcast message to user ${userIdStr}: ${error.message}`);
        failCount++;
      }
    }
    
    const reportMessage = `✅ Broadcast Report:\n\n` +
                         `📤 Total Messages Sent: ${successCount}\n` +
                         `❌ Failed: ${failCount}`;
    
    await ctx.reply(reportMessage, makeMainKeyboard(true, userId));
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdUsersHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }
    
    const totalUsers = allUsers.size;
    const loggedInUsers = Object.keys(userSessions).length;
    const notLoggedInUsers = totalUsers - loggedInUsers;
    
    const message = `📊 Users Statistics:\n\n` +
                   `👥 Total Users (Started Bot): ${totalUsers}\n` +
                   `✅ Logged In Users: ${loggedInUsers}\n` +
                   `❌ Not Logged In: ${notLoggedInUsers}`;
    
    await ctx.reply(message, makeMainKeyboard(true, userId));
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdSignalHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) {
      await ctx.reply("Admin only!", makeMainKeyboard(true, userId));
      return;
    }

    if (savedChannels.length === 0) {
      await ctx.reply("📡 No channels have been added yet.\nUse /addchannel to add a signal source.", makeMainKeyboard(true, userId));
      return;
    }

    let message = `📡 CHANNEL SIGNAL STATUS\n\n`;
    
    savedChannels.forEach(ch => {
      const signal = channelSignals[ch.id];
      let status = "🔴 NO SIGNAL";
      let details = "";
      
      if (signal) {
        const signalAge = Date.now() - signal.receivedAt;
        if (signalAge > CHANNEL_SIGNAL_EXPIRY_TIME) {
          status = "🔴 EXPIRED";
        } else {
          status = "🟢 ACTIVE";
        }
        details = `\n  Period: ${signal.fullPeriod}\n  Prediction: ${signal.prediction === 'B' ? 'BIG' : 'SMALL'}\n  Age: ${Math.floor(signalAge / 1000)}s`;
      }
      
      message += `📌 ${ch.name} (ID: ${ch.id})\n  Status: ${status}${details}\n\n`;
    });
    
    await ctx.reply(message, makeMainKeyboard(true, userId));
  });

  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdAddChannelHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) return;
    const text = ctx.message.text;
    const regex = /\/addchannel\s+([-\w]+)\s+"([^"]+)"\s+(\d+)/;
    const match = text.match(regex);

    if (!match) {
      return ctx.reply('Usage: /addchannel ID "Name" Confidence\nEx: /addchannel -100123456 "AlinKar-Signal" 65');
    }

    if (savedChannels.length >= 10) {
      return ctx.reply('❌ Max 10 channels allowed in menu strategy!');
    }

    const newChannel = {
      id: match[1],
      name: match[2],
      reliability: parseInt(match[3])
    };

    const exists = savedChannels.find(ch => ch.id === newChannel.id);
    if (exists) {
      return ctx.reply('⚠️ Channel ID already exists. Remove it first.');
    }

    savedChannels.push(newChannel);
    saveSavedChannels();
    ctx.reply(`✅ Added Channel:\nName: ${newChannel.name}\nID: ${newChannel.id}\nConf: ${newChannel.reliability}%`);
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function cmdRemoveChannelHandler(ctx) {
  const userId = ctx.from.id;
  const result = await withCommandLock(userId, async () => {
    if (!ADMIN_IDS.includes(userId)) return;

    const args = ctx.message.text.split(' ');
    const targetId = args[1];

    if (!targetId) return ctx.reply('Usage: /removechannel <ChannelID>');

    const initialLength = savedChannels.length;
    savedChannels = savedChannels.filter(ch => ch.id !== targetId);
    saveSavedChannels();

    if (savedChannels.length < initialLength) {
      ctx.reply(`✅ Channel ${targetId} removed.`);
    } else {
      ctx.reply(`❌ Channel ID not found.`);
    }
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

// ========== MANUAL BET FUNCTIONS ==========

async function placeManualBet(userId, betChoice, ctx, bot) {
  try {
    const session = userSessions[userId];
    if (!session) {
      await ctx.reply("❌ ဆက်လက်လုပ်ဆောင်းအရင်ဆုံး Login ဝင်ပါ");
      return;
    }

    const settings = userSettings[userId] || {};
    const gameType = settings.game_type || "TRX";
    
    let betType;
    if (betChoice === 'B' || betChoice === 'S') {
      betType = "BS";
    } else {
      betType = "COLOR";
    }
    
    userManualState[userId] = {
      state: "MANUAL_BET_AMOUNT_SELECT",
      betChoice: betChoice,
      gameType: gameType,
      betType: betType
    };
    
    let betChoiceText;
    if (betChoice === 'B') betChoiceText = 'BIG';
    else if (betChoice === 'S') betChoiceText = 'SMALL';
    else if (betChoice === 'R') betChoiceText = '🔴 RED';
    else if (betChoice === 'G') betChoiceText = '🟢 GREEN';
    else if (betChoice === 'V') betChoiceText = '🟣 VIOLET';
    
    await ctx.reply(
      `🎯 You selected: ${betChoiceText}\n` +
      `🎮 Game: ${gameType}\n\n` +
      `💰 Select your bet amount:`,
      makeBetAmountKeyboard()
    );
    
  } catch (error) {
    logging.error(`Manual bet error for user ${userId}: ${error.message}`);
    await ctx.reply(`❌ Bet error: ${error.message}`);
  }
}

async function processManualBetAmountWithMultiplier(userId, baseAmount, multiplier, ctx) {
  try {
    const state = userManualState[userId];
    if (!state) {
      await ctx.reply("❌ Session expired. Please try again.", makeManualBetKeyboard());
      return;
    }
    
    const totalAmount = baseAmount * multiplier;
    const session = userSessions[userId];
    const settings = userSettings[userId] || {};
    
    if (!session) {
      await ctx.reply("❌ ဆက်လက်လုပ်ဆောင်းအရင်ဆုံး Login ဝင်ပါ");
      delete userManualState[userId];
      return;
    }
    const gameType = state.gameType || settings.game_type || "TRX";
    const issueRes = await safeExecute(userId, () => getGameIssueRequest(session, gameType), null);
    if (!issueRes || issueRes.code !== 0) {
      await ctx.reply("❌ Failed to get current issue");
      delete userManualState[userId];
      return;
    }
    
    const data = issueRes.data || {};
    let currentIssue;
    
    if (gameType === "TRX") {
      currentIssue = data.predraw?.issueNumber;
    } else {
      currentIssue = data.issueNumber;
    }
    
    if (!currentIssue) {
      await ctx.reply("❌ Failed to get current issue number");
      delete userManualState[userId];
      return;
    }
    
    const betChoice = state.betChoice;
    const betType = state.betType || "BS";
    
    const selectMap = getSelectMap(betType);
    const selectType = selectMap[betChoice];
    
    if (!selectType) {
      await ctx.reply(`❌ Invalid bet selection: ${betChoice} for bet type: ${betType}`);
      delete userManualState[userId];
      return;
    }

    const { unitAmount, betCount, actualAmount } = computeBetDetails(totalAmount);
    
    if (actualAmount === 0) {
      await ctx.reply(`❌ Invalid bet amount: ${totalAmount} Ks`);
      delete userManualState[userId];
      return;
    }
    
    const balance = await safeExecute(userId, () => getBalance(session, userId), null);
    if (balance === null || balance < actualAmount) {
      await ctx.reply(
        `❌ Insufficient balance!\n\n` +
        `Available: ${balance?.toFixed(2) || 0} Ks\n` +
        `Required: ${actualAmount.toLocaleString()} Ks\n` +
        `Difference: ${(actualAmount - (balance || 0)).toFixed(2)} Ks`
      );
      delete userManualState[userId];
      return;
    }

    logging.info(`🎯 Manual Bet Details for user ${userId}:`);
    logging.info(`  Bet Choice: ${betChoice} (${betType})`);
    logging.info(`  Select Type: ${selectType}`);
    logging.info(`  Game Type: ${gameType}`);
    logging.info(`  Base Amount: ${baseAmount} Ks`);
    logging.info(`  Multiplier: ×${multiplier}`);
    logging.info(`  Total Amount: ${actualAmount} Ks (${unitAmount} × ${betCount})`);
    logging.info(`  Issue: ${currentIssue}`);

    const originalBetType = settings.bet_type;
    settings.bet_type = betType; 
    
    try {
      const betResp = await safeExecute(userId, () => placeBetRequest(session, currentIssue, selectType, unitAmount, betCount, gameType, userId), null);
      
      settings.bet_type = originalBetType;
      
      if (!betResp || betResp.error || betResp.code !== 0) {
        let errorMsg = betResp?.msg || betResp?.error || 'Unknown error';
        await ctx.reply(`❌ လောင်းကစားမအောင်းသားဖြစ်ပါတယ်။
🔄 ပြန်လည်ကြိုးစားနေပါသည်...\n ${errorMsg}`);
        delete userManualState[userId];
        return;
      }

      let betChoiceText;
      if (betChoice === 'B') betChoiceText = 'BIG';
      else if (betChoice === 'S') betChoiceText = 'SMALL';
      else if (betChoice === 'R') betChoiceText = '🔴 RED';
      else if (betChoice === 'G') betChoiceText = '🟢 GREEN';
      else if (betChoice === 'V') betChoiceText = '🟣 VIOLET';
      
      const message = 
        `✅ BET PLACED SUCCESSFULLY!\n\n` +
        `🆔 Period: ${formatPeriod(currentIssue)}\n` +
        `🎮 Game: ${gameType}\n` +
        `🎯 Bet: ${betChoiceText}\n` +
        `💰 Base Amount: ${baseAmount.toLocaleString()} Ks\n` +
        `🔢 Multiplier: ×${multiplier}\n` +
        `💵 Total Amount: ${actualAmount.toLocaleString()} Ks\n\n` +
        `⏳ Waiting for result...`;
      
      await ctx.reply(message, makeManualBetKeyboard());

      if (!userPendingBets[userId]) {
        userPendingBets[userId] = {};
      }
      userPendingBets[userId][currentIssue] = [betChoice, actualAmount, false];

      if (!userManualBetHistory[userId]) {
        userManualBetHistory[userId] = [];
      }
      userManualBetHistory[userId].unshift({
        period: currentIssue,
        betChoice: betChoice,
        baseAmount: baseAmount,
        multiplier: multiplier,
        totalAmount: actualAmount,
        result: "PENDING",
        winAmount: 0,
        timestamp: Date.now(),
        betType: betType,
        gameType: gameType
      });

      if (userManualBetHistory[userId].length > 20) {
        userManualBetHistory[userId] = userManualBetHistory[userId].slice(0, 20);
      }
      
    } catch (error) {
      settings.bet_type = originalBetType;
      throw error;
    }
    
    delete userManualState[userId];
    
  } catch (error) {
    logging.error(`Manual bet processing error for user ${userId}: ${error.message}`);
    await ctx.reply(`❌ Bet error: ${error.message}`);
    delete userManualState[userId];
  }
}

// ========== LIVE RESULTS FUNCTIONS - USING PUBLIC API ==========

async function getTRXGameResultsNew(session, gameType = "TRX") {
  try {
    const timestamp = Date.now();
    const url = API_ENDPOINTS.RESULTS;
    const fullUrl = `${url}?ts=${timestamp}`;
    
    logging.info(`Fetching TRX results from public API: ${fullUrl}`);
    
    const response = await makeRequest(fullUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Mobile Build/QP1A.190711.020)',
        'Connection': 'Keep-Alive',
        'Authorization': TRX_AUTH
      }
    });
    
    const data = response.data;
    
    logging.info(`TRX Public API Response received`);
    
    if (data && data.list) {
      logging.info(`Successfully fetched ${data.list.length} TRX results from public API`);
      return { code: 0, data: { list: data.list } };
    } else if (data && data.data && data.data.list) {
      logging.info(`Successfully fetched ${data.data.list.length} TRX results from public API (nested)`);
      return { code: 0, data: data.data };
    } else {
      logging.error(`Failed to get TRX results: Invalid response structure from public API`);
      
      logging.info("Trying fallback TRX API method...");
      const fallbackUrl = API_ENDPOINTS.ISSUE;
      const fallbackResponse = await makeRequest(`${fallbackUrl}?ts=${timestamp}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Mobile Build/QP1A.190711.020)',
          'Connection': 'Keep-Alive',
          'Authorization': TRX_AUTH
        }
      });
      
      const fallbackData = fallbackResponse.data;
      if (fallbackData && fallbackData.list) {
        logging.info(`Successfully fetched ${fallbackData.list.length} TRX results from fallback API`);
        return { code: 0, data: { list: fallbackData.list } };
      }
      
      return { code: -1, msg: "Invalid response structure from TRX API" };
    }
  } catch (error) {
    logging.error(`Error getting TRX results from public API: ${error.message}`);
    
    try {
      logging.info("Trying fallback TRX API method via enhanced request...");
      const body = {
        "pageNo": 1,
        "pageSize": 10,
        "gameCode": "TrxWinGo_1M",
        "language": 7,
        "random": "367817611041"
      };
      
      body.signature = signMd5Original(body).toUpperCase();
      body.timestamp = Math.floor(Date.now() / 1000);
      
      const fakeSession = {
        platform: DEFAULT_BASE_URL,
        token: null,
        userId: 'unknown'
      };
      
      const response = await enhancedPostRequest(fakeSession, "GetHistoryIssuePage", body, 'unknown');
      const data = response;
      
      if (data && data.code === 0 && data.data && data.data.list) {
        logging.info(`Successfully fetched ${data.data.list.length} TRX results from fallback API`);
        return data;
      } else {
        logging.error(`Fallback TRX API also failed: ${data?.msg || 'Unknown error'}`);
        return data;
      }
    } catch (fallbackError) {
      logging.error(`Both TRX API methods failed: ${fallbackError.message}`);
      return { error: fallbackError.message };
    }
  }
}

async function handleResultsCommand(ctx, userId, bot) {
  try {
    const session = userSessions[userId];
    const settings = userSettings[userId] || {};
    const gameType = settings.game_type || "TRX";

    if (!session) {
      await ctx.reply("❌ ဆက်လက်လုပ်ဆောင်းအရင်ဆုံး Login ဝင်ပါ");
      return;
    }

    let resultsData;
    if (gameType === "TRX") {
     
      resultsData = await getTRXGameResultsNew(session, gameType);
    } else {
      resultsData = await getWingoGameResults(session, gameType);
    }

    if (resultsData && resultsData.code === 0 && resultsData.data && resultsData.data.list) {
      const results = resultsData.data.list.slice(0, 10);
      
      const message = await formatResults(results, gameType);
      
      if (!message) {
        await ctx.reply("❌ Failed to format results");
        return;
      }
      
      if (userResultsMessages[userId]) {
        try {
          await bot.telegram.deleteMessage(userId, userResultsMessages[userId].messageId);
          logging.info(`Deleted old results message for user ${userId}`);
        } catch (deleteError) {
        }
      }
      
      const resultMessage = await ctx.reply(message, { parse_mode: 'HTML' });
      
      userResultsMessages[userId] = {
        messageId: resultMessage.message_id,
        chatId: userId,
        lastResults: message,
        gameType: gameType,
        lastUpdateTime: Date.now()
      };
      userLastResults[userId] = message;
      
      logging.info(`Sent new results message via command for user ${userId}`);
      
    } else {
      await ctx.reply("❌ Failed to fetch results");
    }
  } catch (error) {
    logging.error(`Error fetching results: ${error.message}`);
    await ctx.reply("❌ Error fetching results");
  }
}

async function handleRecentBetsCommand(ctx, userId) {
  try {
    const manualBets = userManualBetHistory[userId] || [];
    
    if (manualBets.length > 0) {
      let message = `📝 <b>Recent Manual Bets</b>\n`;
      message += `══════════════════════════════════════\n\n`;
      message += `<code>Period    Type     Amount       W/L</code>\n`;
      
      let totalWins = 0;
      let totalLosses = 0;
      let totalProfit = 0;
      
      manualBets.slice(0, 10).forEach((bet) => {
        const period = bet.period ? bet.period.slice(-5) : "N/A";
        const result = bet.result === "WIN" ? "WIN" : 
                      bet.result === "LOSE" ? "LOSE" : "PENDING";
        
        let typeText = "";
        if (bet.betChoice === 'B') typeText = 'BIG';
        else if (bet.betChoice === 'S') typeText = 'SMALL';
        else if (bet.betChoice === 'R') typeText = 'RED';
        else if (bet.betChoice === 'G') typeText = 'GREEN';
        else if (bet.betChoice === 'V') typeText = 'VIOLET';
        
        let amountText = "";
        if (bet.result === "WIN") {
          const winAmount = bet.winAmount || (bet.totalAmount * 0.96);
          amountText = `+${Math.round(winAmount).toLocaleString()} Ks`;
          totalWins++;
          totalProfit += winAmount;
        } else if (bet.result === "LOSE") {
          amountText = `-${Math.round(bet.totalAmount).toLocaleString()} Ks`;
          totalLosses++;
          totalProfit -= bet.totalAmount;
        } else {
          amountText = `${Math.round(bet.totalAmount).toLocaleString()} Ks`;
        }

        const periodPad = period.padEnd(9, ' ');
        const typePad = typeText.padEnd(9, ' ');
        const amountPad = amountText.padEnd(13, ' ');
        
        message += `<code>${periodPad}${typePad}${amountPad}${result}</code>\n`;
      });

      message += `<code>─────────────────────────────────────────────</code>\n`;

      let profitColor = totalProfit >= 0 ? '🟢' : '🔴';
      let profitSign = totalProfit >= 0 ? '+' : '';
      
      message += 
        `<b>${profitColor} Summary</b>\n` +
        `<b>Wins: ${totalWins} | Losses: ${totalLosses}</b>\n` +
        `<b>Net Profit: ${profitSign}${Math.round(totalProfit).toLocaleString()} Ks</b>\n\n` +
        `<i>Last updated: ${new Date().toLocaleTimeString()}</i>`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply("No manual bets found yet. Place your first bet!");
    }
  } catch (error) {
    logging.error(`Error showing recent bets: ${error.message}`);
    await ctx.reply("❌ Error fetching recent bets");
  }
}

// ========== CALLBACK QUERY HANDLER ==========

async function callbackQueryHandler(ctx) {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  
  const result = await withCommandLock(userId, async () => {
    if (data.startsWith("platform:")) {
      const platformKey = data.split(":")[1];
      const selectedUrl = PLATFORMS[platformKey];
      
      if (selectedUrl) {
        if (!userTemp[userId]) userTemp[userId] = {};
        userTemp[userId].platformUrl = selectedUrl;
        userTemp[userId].platformName = platformKey;
        
        await ctx.reply(
          `✅ ${platformKey}\n` +
          `🔰 အောက်ရှိတောင်းဆိုမူအတိုင်းဖြည့်ပါ\n\n` +
          `📞 Phone Number\n` +
          `📱 Password`
        );
      } else {
        await ctx.reply("❌ Invalid Platform");
      }
      await ctx.deleteMessage();
      return;
    }
    
    if (!await checkUserAuthorized(ctx)) {
      return;
    }
    
    if (data.startsWith("loss_alert:")) {
      const limit = parseInt(data.split(":")[1]);
      const settings = userSettings[userId] || {};
      
      settings.consecutive_loss_limit = limit > 0 ? limit : null;
      settings.consecutive_loss_count = 0;
      settings.alert_sent_for_this_streak = false;
      
      await clearAlertForUser(ctx.telegram, userId);
      
      saveUserSettings(); 
      
      let description = "";
      if (limit === 0) {
        description = "ပိတ်ထားသည်";
      } else {
        description = `${limit} ကြိမ်ဆက်တိုက်ရှုံးပါက သတိပေးမည်`;
      }
      
      await ctx.reply(`⚠️ Loss Alert Limit: ${limit === 0 ? "Disabled" : limit} (${description})`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
      return;
    }
    
    if (data.startsWith("lose_sl:")) {
      const loseSLValue = parseInt(data.split(":")[1]);
      const settings = userSettings[userId];
      
      settings.lose_sl = loseSLValue > 0 ? loseSLValue : null;
      settings.lose_sl_consecutive_losses = 0;
      settings.lose_sl_skip_count = 0;
      settings.lose_sl_skipped_count = 0;
      settings.lose_sl_active = false;
      
      saveUserSettings();
      
      let description = "";
      if (loseSLValue === 0) {
        description = "Disabled";
      } else {
        description = `Skip ${loseSLValue} periods after ${loseSLValue} consecutive losses`;
      }
      
      await ctx.reply(`💀 Lose SL: ${loseSLValue} (${description})`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    }
    
    if (data.startsWith("direction:")) {
      const direction = data.split(":")[1];
      const settings = userSettings[userId] || {};
      
      settings.bet_direction = direction;
      saveUserSettings();
      
      let description = "";
      let examples = "";
      
      if (direction === "STRAIGHT") {
        description = "📊 STRAIGHT MODE";
        examples = "• Strategy က 'BIG' ဆို → 'BIG' လောင်းမယ်\n";
        examples += "• Strategy က 'SMALL' ဆို → 'SMALL' လောင်းမယ်\n";
        examples += "• Strategy က 'GREEN' ဆို → 'GREEN' လောင်းမယ်";
      } else {
        description = "📉 REVERSE MODE";
        examples = "• Strategy က 'BIG' ဆို → 'SMALL' လောင်းမယ်\n";
        examples += "• Strategy က 'SMALL' ဆို → 'BIG' လောင်းမယ်\n";
        examples += "• Strategy က 'GREEN' ဆို → 'RED' လောင်းမယ်\n";
        examples += "• Strategy က 'RED' ဆို → 'GREEN' လောင်းမယ်";
      }
      
      const message = 
        `✅ Bet Direction Updated!\n\n` +
        `${description}\n\n` +
        `📝 ဥပမာ:\n` +
        `${examples}\n\n` +
        `⚡ နောက်တစ်ကြိမ် Bet ကစားတိုင်း ဒီ Mode အတိုင်း အလုပ်လုပ်ပါမည်။`;
      
      await ctx.reply(message, makeMainKeyboard(true, userId));
      
      try {
        await ctx.deleteMessage();
      } catch (error) {
      
      }
    }
    
    if (data.startsWith("strategy:")) {
      const strategyData = data.split(":");
      const strategy = strategyData[1]; 
      
      if (strategy === "CHANNEL_SIGNAL" && strategyData[2]) {
        userSettings[userId].strategy = "CHANNEL_SIGNAL";
        userSettings[userId].target_channel_id = strategyData[2]; 
        
        const chName = savedChannels.find(ch => ch.id === strategyData[2])?.name || "Unknown";
        await ctx.reply(`Strategy: 📡 Copying form ${chName}`, makeMainKeyboard(true, userId));
        await ctx.deleteMessage();
      } 
      else {
        userSettings[userId].strategy = strategy;
        delete userSettings[userId].target_channel_id;
        
        let strategyName = "";
        let description = "";
        
        switch(strategy) {
          case "BS_ORDER":
            strategyName = "BS-Order";
            userState[userId] = { state: "INPUT_BS_PATTERN" };
            await ctx.reply("Please enter your BS pattern (e.g., BSBSSBBS):");
            await ctx.deleteMessage();
            return;

          case "DREAM":
            strategyName = "DREAM";
            description = "Pattern-based strategy keyed by result digits";
            break;
            
          case "ALINKAR":
            strategyName = "ALINKAR";
            description = "Streak-based: oppose singles/triples, follow doubles/long";
            break;
            
          case "MAY_BARANI":
            strategyName = "MAY BARANI";
            description = "Numerological sum difference strategy";
            break;  
            
          case "CHAT_GPT":
            strategyName = "Chat GPT Pattern Recognition";
            description = "Uses AI pattern recognition for predictions";
            break;
            
          case "COLOR_TREND":
            strategyName = "Color Trend";
            description = "Follows color patterns for betting";
            break;
            
          case "TREND_FOLLOW":
            strategyName = "Trend Follow V1";
            userState[userId] = { state: "INPUT_BS_WAIT_COUNT" };
            await ctx.reply("Select BS/SB Wait Count:", makeNumberPadKeyboard());
            await ctx.deleteMessage();
            return;
            
          case "BREAKER":
            strategyName = "Breaker Strategy";
            userSettings[userId].strategy = "BREAKER";
            saveUserSettings();
            await ctx.reply("🛡️ Breaker Strategy Selected.\n\nSelect Streak Wait Count (3-9):", makeStreakCountKeyboard());
            await ctx.deleteMessage();
            return;

          default:
            strategyName = strategy;
            description = "Custom strategy";
        }
        
        await ctx.reply(
          `📛 Name: ${strategyName}`,
          makeMainKeyboard(true, userId)
        );
        await ctx.deleteMessage();
      }
      saveUserSettings();
      return;
    } else if (data.startsWith("breaker_count:")) {
      const count = parseInt(data.split(":")[1]);
      userSettings[userId].breaker_streak_count = count;
      saveUserSettings();
      await ctx.reply(`✅ Breaker Streak Count set to: ${count}`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    } else if (data.startsWith("number:")) {
      const number = parseInt(data.split(":")[1]);
      const currentState = userState[userId]?.state;
      
      if (currentState === "INPUT_BS_WAIT_COUNT") {
        userSettings[userId].bs_wait_count = number;
        saveUserSettings();
        await ctx.reply(`BS/SB Wait Count: ${number}`, makeMainKeyboard(true, userId));
        delete userState[userId];
      }
      await ctx.deleteMessage();
    } else if (data.startsWith("betting_strategy:")) {
      const bettingStrategy = data.split(":")[1];
      userSettings[userId].betting_strategy = bettingStrategy;
      
      userSettings[userId].martin_index = 0;
      userSettings[userId].dalembert_units = 1;
      userSettings[userId].consecutive_losses = 0;
      userSettings[userId].skip_betting = false;
      userSettings[userId].custom_index = 0;
      saveUserSettings();
      
      await ctx.reply(`Betting Strategy: ${bettingStrategy}`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    } else if (data.startsWith("game_type:")) {
      const gameType = data.split(":")[1];
      userSettings[userId].game_type = gameType;
      
      if (gameType === "WINGO30S") {
        if (!["BS_ORDER", "TREND_FOLLOW", "CHAT_GPT", "CHANNEL_SIGNAL", "BREAKER"].includes(userSettings[userId].strategy)) {
          userSettings[userId].strategy = "CHANNEL_SIGNAL";
        }
      } else if (gameType === "TRX") {
        if (["TREND_FOLLOW"].includes(userSettings[userId].strategy)) {
          userSettings[userId].strategy = "CHANNEL_SIGNAL";
        }
      }
      saveUserSettings();
      await ctx.reply(`Game Type: ${gameType}`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    } else if (data.startsWith("entry_layer:")) {
      const layerValue = parseInt(data.split(":")[1]);
      userSettings[userId].layer_limit = layerValue;
    
      if (layerValue === 2) {
        userSettings[userId].entry_layer_state = { 
          waiting_for_loses: true, 
          consecutive_loses: 0,
          required_loses: 1,
          real_betting_started: false
        };
      } else if (layerValue === 3) {
        userSettings[userId].entry_layer_state = { 
          waiting_for_loses: true, 
          consecutive_loses: 0,
          required_loses: 2,
          real_betting_started: false
        };
      } else if (layerValue >= 4 && layerValue <= 9) {
        userSettings[userId].entry_layer_state = { 
          waiting_for_loses: true, 
          consecutive_loses: 0,
          required_loses: layerValue - 1,
          real_betting_started: false
        };
      }
      saveUserSettings();
      
      let description = "";
      if (layerValue === 1) {
        description = "Bet immediately according to strategy";
      } else if (layerValue === 2) {
        description = "Wait for 1 consecutive loss before real betting";
      } else if (layerValue === 3) {
        description = "Wait for 2 consecutive losses before real betting";
      } else if (layerValue >= 4 && layerValue <= 9) {
        description = `Wait for ${layerValue - 1} consecutive losses before real betting`;
      }
      
      await ctx.reply(`Entry Layer : ${layerValue} (${description})`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    } else if (data.startsWith("sl_layer:")) {
      const slValue = parseInt(data.split(":")[1]);
      userSettings[userId].sl_layer = slValue > 0 ? slValue : null;
      userSettings[userId].consecutive_losses = 0;
      userSettings[userId].skip_betting = false;
      
      userSettings[userId].martin_index = userSettings[userId].original_martin_index || 0;
      userSettings[userId].dalembert_units = userSettings[userId].original_dalembert_units || 1;
      userSettings[userId].custom_index = userSettings[userId].original_custom_index || 0;
      
      delete userSLSkipWaitingForWin[userId];
      userShouldSkipNext[userId] = false;
      
      saveUserSettings();
      
      let description = "";
      if (slValue === 0) {
        description = "Disabled";
      } else {
        description = `Skip after ${slValue} consecutive losses`;
      }
      
      await ctx.reply(`SL Layer : ${slValue} (${description})`, makeMainKeyboard(true, userId));
      await ctx.deleteMessage();
    } else if (data.startsWith("mode:")) {
      const mode = data.split(":")[1];
      const settings = userSettings[userId];

      if (mode === "virtual") {
        settings.virtual_mode = true;
        settings.admin_virtual_mode = false; 
    
        if (!userStats[userId]) {
          userStats[userId] = {};
        }
        if (userStats[userId].virtual_balance === undefined) {
          userStats[userId].virtual_balance = VIRTUAL_BALANCE;
        }
        saveUserSettings();
        await ctx.reply(`🖥️ Switched to Virtual Mode (${VIRTUAL_BALANCE} Ks)`, makeMainKeyboard(true, userId));
      } else if (mode === "real") {
        settings.virtual_mode = false;
        settings.admin_virtual_mode = false; 
        
        saveUserSettings();
        await ctx.reply("💵 Switched to Real Mode", makeMainKeyboard(true, userId));
      }
      
      await ctx.deleteMessage();
    }
    
    else if (data.startsWith("manual_amount:")) {
      const amountType = data.split(":")[1];
      
      if (amountType === "cancel") {
        await ctx.reply("❌ Bet cancelled", makeManualBetKeyboard());
        delete userManualState[userId];
        await ctx.deleteMessage();
        return;
      }
      
      const amount = parseInt(amountType);
      if (amount >= 100 && amount <= 100000) {
        userManualState[userId] = {
          ...userManualState[userId],
          baseAmount: amount,
          state: "MANUAL_BET_MULTIPLIER_SELECT"
        };
        
        await ctx.reply(
          `💰 Amount: ${amount.toLocaleString()} Ks\n\n` +
          `🔢 multiplier:`,
          makeMultiplierKeyboard()
        );
        await ctx.deleteMessage();
      } else {
        await ctx.reply(`❌ Invalid amount: ${amount} Ks. Please select a valid amount.`, makeBetAmountKeyboard());
      }
    }
    
    else if (data.startsWith("multiplier:")) {
      const multiplierType = data.split(":")[1];
      const state = userManualState[userId];
      
      if (state && state.state === "MANUAL_BET_MULTIPLIER_SELECT") {
        if (multiplierType === "custom") {
          state.state = "MANUAL_BET_CUSTOM_MULTIPLIER";
          
          await ctx.reply(
            `💰 Selected Base Amount: ${state.baseAmount.toLocaleString()} Ks\n\n` +
            `✏️ Multiplier တန်ဖိုးကို ရွေးချယ်ထည့်သွင်းပါ\nအနည်းဆုံး 1 ၊ အများဆုံး 1000`, 
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ Cancel", "manual_amount:cancel")]
            ])
          );
          await ctx.deleteMessage();
          return;
        }
        
        const multiplier = parseInt(multiplierType);
        
        await processManualBetAmountWithMultiplier(userId, state.baseAmount, multiplier, ctx);
        await ctx.deleteMessage();
      }
    }
    
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

// ========== TEXT MESSAGE HANDLER ==========

async function textMessageHandler(ctx) {
  const messageObj = ctx.message || ctx.channelPost;
  if (!messageObj || !messageObj.text) return;

  const userId = ctx.from ? ctx.from.id : null;
  const rawText = messageObj.text;
  
  
  if (ctx.channelPost) {
    await enhancedChannelPostHandler(ctx, ctx.telegram);
    return;
  }
 if (userTemp[userId] && rawText === "❌ Cancel") {
    delete userTemp[userId];
    await ctx.reply("❌ Operation cancelled.", makeAdminKeyboard());
    return;
  }

  if (userTemp[userId] && userTemp[userId].state === "ADMIN_ADD_USER") {
    const targetId = rawText.trim();
    if (targetId && !isNaN(targetId)) {
      const result = await syncUserToBoth(parseInt(targetId), 'add');
      await ctx.reply(result.success ? `✅ Added ${targetId}` : `⚠️ Error: ${result.error}`, makeAdminKeyboard());
      delete userTemp[userId];
    } else {
      await ctx.reply("❌ Invalid ID. Please enter a valid number.", Markup.keyboard([["❌ Cancel"]]));
    }
    return;
  }

  
  if (userTemp[userId] && userTemp[userId].state === "ADMIN_REMOVE_USER") {
    const targetId = rawText.trim();
    if (targetId && !isNaN(targetId)) {
      const result = await syncUserToBoth(parseInt(targetId), 'remove');
      await ctx.reply(result.success ? `✅ Removed ${targetId}` : `⚠️ Error: ${result.error}`, makeAdminKeyboard());
      delete userTemp[userId];
    } else {
      await ctx.reply("❌ Invalid ID. Please enter a valid number.", Markup.keyboard([["❌ Cancel"]]));
    }
    return;
  }

  if (userTemp[userId] && userTemp[userId].state === "ADMIN_ADD_BYPASS") {
    const targetId = rawText.trim();
    if (targetId && !isNaN(targetId)) {
      bypassMinBalanceUsers.add(parseInt(targetId));
      saveBypassUsers();
      await ctx.reply(`✅ Added ${targetId} to bypass list.`, makeAdminKeyboard());
      delete userTemp[userId];
    } else {
      await ctx.reply("❌ Invalid ID. Please enter a valid number.", Markup.keyboard([["❌ Cancel"]]));
    }
    return;
  }

  if (userTemp[userId] && userTemp[userId].state === "ADMIN_REMOVE_BYPASS") {
    const targetId = rawText.trim();
    if (targetId && !isNaN(targetId)) {
      if (bypassMinBalanceUsers.has(parseInt(targetId))) {
        bypassMinBalanceUsers.delete(parseInt(targetId));
        saveBypassUsers();
        await ctx.reply(`✅ Removed ${targetId} from bypass list.`, makeAdminKeyboard());
      } else {
        await ctx.reply(`❌ User ${targetId} not found in bypass list.`, makeAdminKeyboard());
      }
      delete userTemp[userId];
    } else {
      await ctx.reply("❌ Invalid ID. Please enter a valid number.", Markup.keyboard([["❌ Cancel"]]));
    }
    return;
  }
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  
  const result = await withCommandLock(userId, async () => {
  
    if (rawText.startsWith("/addbypass")) {
      await handleAddBypass(ctx);
      return;
    }
    
    if (rawText.startsWith("/removebypass")) {
      await handleRemoveBypass(ctx);
      return;
    }
    
    if (rawText.startsWith("/add")) {
      await handleAddUser(ctx);
      return;
    }
    
    if (rawText.startsWith("/remove")) {
      await handleRemoveUser(ctx);
      return;
    }
    
    if (rawText.startsWith("/show")) {
      await handleShowAll(ctx);
      return;
    }
    
    if (rawText.startsWith("/broadcast")) {
      await handleBroadcast(ctx);
      return;
    }
    
    if (rawText.startsWith("/users")) {
      await handleUserStats(ctx);
      return;
    }
    
    if (rawText.startsWith("/signal")) {
      await handleSignalStatus(ctx);
      return;
    }
    
    if (rawText.startsWith("/addchannel")) {
      await handleAddChannel(ctx);
      return;
    }
    
    if (rawText.startsWith("/removechannel")) {
      await handleRemoveChannel(ctx);
      return;
    }
    
    if (rawText.startsWith("/adminbalance")) {
      await handleAdminVirtualBalance(ctx);
      return;
    }
    
  
    if (rawText.includes("❌ Cancel")) {
      if (userTemp[userId]) {
        delete userTemp[userId];
        await ctx.reply("❌ Operation cancelled.", makeMainKeyboard(true, userId));
        return;
      }
      
      if (userManualState[userId]) {
        delete userManualState[userId];
        await ctx.reply("❌ Operation cancelled.", makeManualBetKeyboard());
        return;
      }
    }
    
  
    if (rawText.includes("⚙️ Admin Panel")) {
      if (!ADMIN_IDS.includes(userId)) {
        await ctx.reply("❌ Admin only!", makeMainKeyboard(true, userId));
        return;
      }
      
      await ctx.reply(
        `⚙️ ADMIN PANEL\n\n` +
        `Select an option to manage the system:`,
        makeAdminKeyboard()
      );
      return;
    }
    
    if (rawText.includes("💰 Admin Balance")) {
      if (!ADMIN_IDS.includes(userId)) {
        await ctx.reply("❌ Admin only!", makeMainKeyboard(true, userId));
        return;
      }
      
      userTemp[userId] = { state: "ADMIN_VIRTUAL_BALANCE_INPUT" };
      
      await ctx.reply(
        "💰 ADMIN VIRTUAL BALANCE\n" +
        "========================\n\n" +
        "Enter the amount for Admin Virtual Balance:",
        Markup.keyboard([["❌ Cancel"]])
      );
      return;
    }
    
    if (rawText.includes("➕ Add User")) {
      await handleAddUser(ctx);
      return;
    }
    
    if (rawText.includes("❌ Remove User")) {
      await handleRemoveUser(ctx);
      return;
    }
    
    if (rawText.includes("➕ Add Bypass")) {
      await handleAddBypass(ctx);
      return;
    }
    
    if (rawText.includes("❌ Remove Bypass")) {
      await handleRemoveBypass(ctx);
      return;
    }
    
    if (rawText.includes("📡 Add Channel")) {
      await handleAddChannel(ctx);
      return;
    }
    
    if (rawText.includes("🗑️ Remove Channel")) {
      await handleRemoveChannel(ctx);
      return;
    }
    
    if (rawText.includes("📋 Show All")) {
      await handleShowAll(ctx);
      return;
    }
    
    if (rawText.includes("👥 User Stats")) {
      await handleUserStats(ctx);
      return;
    }
    
    if (rawText.includes("🔄 Sync Website")) {
      if (!ADMIN_IDS.includes(userId)) {
        await ctx.reply("❌ Admin only!");
        return;
      }
      
      await ctx.reply("🔄 Syncing local users to website...");
      await verifyAndSyncWebsite();
      
      const response = await fetch(`${TRX_API_URL}?secret=${BOT_SECRET}`);
      const result = await response.json();
      
      await ctx.reply(
        `✅ Sync Complete!\n` +
        `📂 Local: ${allowed777bigwinIds.size}\n` +
        `🌐 Website: ${result.count || 0}`
      );
      return;
    }
    
    if (rawText.includes("📢 Broadcast")) {
      await handleBroadcast(ctx);
      return;
    }
    
    if (rawText.includes("📊 Signals")) {
      await handleSignalStatus(ctx);
      return;
    }
    
    if (rawText.includes("🔙 Back to Home")) {
      if (userResultsMessages[userId]) {
        try {
          await ctx.telegram.deleteMessage(userId, userResultsMessages[userId].messageId);
          logging.info(`User ${userId} Main menu ပြန်ရောက်လို့ live result message ဖျက်လိုက်ပြီ`);
        } catch (deleteError) {
          logging.warning(`User ${userId} အတွက် အဟောင်း message ဖျက်လို့မရဘူး: ${deleteError.message}`);
        }
        delete userResultsMessages[userId];
        delete userLastResults[userId];
      }
      
      delete userManualState[userId];
      await ctx.reply("🏠 Main Menu", makeMainKeyboard(true, userId));
      return;
    }
    
 
    if (userTemp[userId] && userTemp[userId].state === "ADMIN_VIRTUAL_BALANCE_INPUT") {
      const amount = parseFloat(rawText.trim().replace(/,/g, ''));
      
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply("❌ Invalid amount. Please enter a valid number:", Markup.keyboard([["❌ Cancel"]]));
        return;
      }
      
      if (!userStats[userId]) {
        userStats[userId] = { admin_virtual_balance: amount, admin_start_balance: amount, profit: 0.0 };
      } else {
        userStats[userId].admin_virtual_balance = amount;
        userStats[userId].admin_start_balance = amount;
        userStats[userId].profit = 0.0;
      }
      
      userSettings[userId].virtual_mode = true;
      userSettings[userId].admin_virtual_mode = true;
      
      saveUserSettings();
      
      await ctx.reply(
        `✅ Admin Virtual Balance Set!\n\n` +
        `💰 Balance: ${amount.toLocaleString()} Ks\n` +
        `📊 Mode: ADMIN Virtual`,
        makeMainKeyboard(true, userId)
      );
      
      delete userTemp[userId];
      return;
    }
    
  
    if (rawText.includes("⚠️ Loss Alert Limit")) {
      const settings = userSettings[userId] || {};
      const currentLimit = settings.consecutive_loss_limit || 0;
      
      let message = `⚠️ ဆက်တိုက်ရှုံးနိမ့်မှုသတိပေးချက် ဆက်တင်များ\n\n`;
      message += `လက်ရှိကန့်သတ်ချက်: ${currentLimit === 0 ? "ပိတ်ထားသည်" : currentLimit + " ကြိမ်"}\n\n`;
      message += `ဆက်တိုက်ရှုံးနိမ့်မှု ဒီအကြိမ်ရေရောက်တဲ့အခါ သတိပေးချက် လက်ခံရရှိမည်။\n\n`;
      message += `သင့်ရဲ့သတိပေးချက်ကန့်သတ်ချက်ကို ရွေးချယ်ပါ:`;
      
      await ctx.reply(message, makeLossAlertLimitKeyboard());
      return;
    }
    
  
    if (rawText.includes("🎮 Manual Bet")) {
      if (!userSessions[userId]) {
        await ctx.reply("Please Login first to use manual betting", makeMainKeyboard(false));
        return;
      }
      
      await ctx.reply("🎮 Manual Bet Mode\n\nလုပ်ဆောင်လိုသော Option ကို ရွေးချယ်ပါ:", makeManualBetKeyboard());
      
      await startAutoResultsForUser(userId, ctx.telegram);
      return;
    }
    
    if (userManualState[userId]) {
      const manualState = userManualState[userId];
      
      if (manualState.state === "MANUAL_BET_CUSTOM_AMOUNT") {
        const customAmount = parseInt(text);
        if (!isNaN(customAmount) && customAmount >= 100 && customAmount <= 1000000) {
          await processManualBetAmountWithMultiplier(userId, customAmount, 1, ctx);
        } else {
          await ctx.reply(
            `❌ Invalid amount!\n\n` +
            `Please enter a number between 100 and 1,000,000 Ks.\n` +
            `Enter your custom bet amount:`,
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ Cancel", "manual_amount:cancel")]
            ])
          );
        }
        return;
      }
      else if (manualState.state === "MANUAL_BET_CUSTOM_MULTIPLIER") {
        const customMultiplier = parseInt(text);
        if (!isNaN(customMultiplier) && customMultiplier >= 1 && customMultiplier <= 1000) {
          await processManualBetAmountWithMultiplier(userId, manualState.baseAmount, customMultiplier, ctx);
        } else {
          await ctx.reply(
            `❌ Invalid multiplier!\n\n` +
            `Please enter a number between 1 and 1000.\n` +
            `Enter your custom multiplier:`,
            Markup.inlineKeyboard([
              [Markup.button.callback("❌ Cancel", "manual_amount:cancel")]
            ])
          );
        }
        return;
      }
    }
    
    if (rawText.includes("🎯 Bet Big") || rawText.includes("Bet Big")) {
      await placeManualBet(userId, 'B', ctx, ctx.telegram);
      return;
    }
    
    if (rawText.includes("🎯 Bet Small") || rawText.includes("Bet Small")) {
      await placeManualBet(userId, 'S', ctx, ctx.telegram);
      return;
    }
    
    if (rawText.includes("🔴 Bet Red") || rawText.includes("Bet Red")) {
      await placeManualBet(userId, 'R', ctx, ctx.telegram);
      return;
    }
    
    if (rawText.includes("🟢 Bet Green") || rawText.includes("Bet Green")) {
      await placeManualBet(userId, 'G', ctx, ctx.telegram);
      return;
    }
    
    if (rawText.includes("🟣 Bet Violet") || rawText.includes("Bet Violet")) {
      await placeManualBet(userId, 'V', ctx, ctx.telegram);
      return;
    }
    
    if (rawText.includes("💰 Balance") || rawText.includes("Balance")) {
      const session = userSessions[userId];
      if (session) {
        const balance = await safeExecute(userId, () => getBalance(session, userId), null);
        if (balance !== null) {
          await ctx.reply(`💰 Current Balance: ${balance.toFixed(2)} Ks`, makeManualBetKeyboard());
        } else {
          await ctx.reply("❌ Failed to get balance", makeManualBetKeyboard());
        }
      } else {
        await ctx.reply("❌ ဆက်လက်လုပ်ဆောင်းအရင်ဆုံး Login ဝင်ပါ", makeMainKeyboard(false));
      }
      return;
    }
    
    if (rawText.includes("📊 Live Results") || rawText.includes("Live Results")) {
      await handleResultsCommand(ctx, userId, ctx.telegram);
      return;
    }
    
    if (rawText.includes("📝 Recent Bet") || rawText.includes("Recent Bet")) {
      await handleRecentBetsCommand(ctx, userId);
      return;
    }
    
  
    if (rawText.includes("🔐 Login")) {
      if (userSessions[userId]) {
        logoutUser(userId);
        await ctx.reply("🔓 Existing session logged out. Please select platform again.");
      }
      
      await ctx.reply("🌐 Please Select Game :", makePlatformSelectionKeyboard());
      return;
    }
    
  
    if (rawText.includes("🏁 Info")) {
      await showUserStats(ctx, userId);
      return;
    }
    
 
    if (rawText.includes("🎲 WINGO/TRX")) {
      await ctx.reply("Select Game Type:", makeGameTypeKeyboard());
      return;
    }
    
    
    if (rawText.includes("🧠 Strategy")) {
      const settings = userSettings[userId] || {};
      const gameType = settings.game_type || "TRX";
   
      if (gameType === "TRX") {
        await ctx.reply("📝Choose Strategy📝", makeStrategyKeyboard(userId));
      } else if (gameType === "WINGO30S") {
        await ctx.reply("📝Choose Strategy📝", makeWingoStrategyKeyboard());
      } else {
        await ctx.reply("📝Choose Strategy📝", makeStrategyKeyboard(userId));
      }
      return;
    }
    
  
    if (rawText.includes("🎯 Bet Type")) {
      await ctx.reply("Select Bet Type:", makeBetTypeKeyboard());
      return;
    }
    
  
    if (rawText.includes("💀 Lose SL")) {
      await ctx.reply("💀 Lose SL Settings", makeLoseSLKeyboard());
      return;
    }
    
  
    if (rawText.includes("📊 Bet Direction")) {
      const settings = userSettings[userId] || {};
      const currentDirection = settings.bet_direction || "STRAIGHT";
      
      let message = `📊 Current Bet Direction: ${currentDirection === "STRAIGHT" ? "📊 Straight" : "📉 Reverse"}\n\n`;
      message += `📊 Straight: Strategy မှပေးသော Prediction အတိုင်း အတည့်လောင်းမည်\n`;
      message += `📉 Reverse: Strategy မှပေးသော Prediction ကို ပြောင်းပြန်လောင်းမည်`;
      
      await ctx.reply(message, makeDirectionKeyboard());
      return;
    }
    
   
    if (rawText.includes("⚔️ Start")) {
      const settings = userSettings[userId] || {};
      
      if (!settings.bet_sizes) {
        await ctx.reply("Bot is not working at the moment because some Bot Settings are still to be configured.!", makeMainKeyboard(true, userId));
        return;
      }
      
      if (settings.strategy === "BS_ORDER" && !settings.pattern) {
        settings.pattern = DEFAULT_BS_ORDER;
        settings.pattern_index = 0;
        saveUserSettings();
        await ctx.reply(`No BS order provided. Using default: ${DEFAULT_BS_ORDER}`, makeMainKeyboard(true, userId));
      }
      
      if (settings.betting_strategy === "D'Alembert" && settings.bet_sizes.length > 1) {
        await ctx.reply(
          "❌ D'Alembert strategy အသုံးပြုထားခြင်းကြောင့်Bet Size ကို တစ်ခုသာရေးပေးရန်လိုအပ်ပါသည်\n" +
          "❌ Please set Bet Size again with only one number.",
          makeMainKeyboard(true, userId)
        );
        return;
      }
      
      if (settings.running) {
        await ctx.reply("ကျေးဇူးပြု၍ STOP ပြီးမှ START ပြန်နှိပ်ါ", makeMainKeyboard(true, userId));
        return;
      }
      
      const session = userSessions[userId];
      if (!session) {
        await ctx.reply("ကျေးဇူးပြု၍ အရင်ဆုံး LOGIN ဝင်ပါ။", makeMainKeyboard(true, userId));
        return;
      }
      
      await ctx.reply("🔄 လက်ကျန်ငွေ စစ်ဆေးနေပါသည်...");
      
      try {
        const balance = await safeExecute(userId, () => getBalance(session, userId), null);
        
        if (balance === null) {
          await ctx.reply("❌ လက်ကျန်ငွေ စစ်ဆေးရာတွင် ပြဿနာရှိပါသည်။ ကျေးဇူးပြု၍ ပြန်လည်ကြိုးစားပါ။", makeMainKeyboard(true, userId));
          return;
        }
        
        const canBypassMinBalance = bypassMinBalanceUsers.has(parseInt(userId));
        const isAdmin = ADMIN_IDS.includes(parseInt(userId));
        const canSkipBalanceCheck = canBypassMinBalance || isAdmin;
        
        if (!canSkipBalanceCheck && balance < MINIMUM_BALANCE_REQUIRED) {
          await ctx.reply(
            `❌ ဘော့စတင်ရန် လက်ကျန်ငွေ မလုံလောက်ပါ။\n\n` +
            `💰 လက်ရှိလက်ကျန်ငွေ: ${balance.toFixed(2)} Ks\n` +
            `🎯 လိုအပ်သောအနည်းဆုံးငွေ: ${MINIMUM_BALANCE_REQUIRED.toLocaleString()} Ks\n` +
            `📉 လိုနေသည့်ပမာဏ: ${(MINIMUM_BALANCE_REQUIRED - balance).toFixed(2)} Ks\n\n` +
            `📌 ကျေးဇူးပြု၍ အနည်းဆုံး ${MINIMUM_BALANCE_REQUIRED.toLocaleString()} Ks ပြည့်အောင် ငွေဖြည့်ပါ။`
          );
          return;
        }
        
        await ctx.reply(`✅ လက်ကျန်ငွေ: ${balance.toFixed(2)} Ks - ဘော့စတင်နေပါသည်...`);
        
      } catch (error) {
        await ctx.reply(`❌ လက်ကျန်ငွေ စစ်ဆေးရာတွင် အမှားအယွင်း: ${error.message}`, makeMainKeyboard(true));
        return;
      }
      
      settings.running = true;
      settings.consecutive_errors = 0;
      
      const entryLayer = settings.layer_limit || 1;
      if (entryLayer === 2) {
        settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0, required_loses: 1, real_betting_started: false };
      } else if (entryLayer === 3) {
        settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0, required_loses: 2, real_betting_started: false };
      } else if (entryLayer >= 4 && entryLayer <= 9) {
        settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0, required_loses: entryLayer - 1, real_betting_started: false };
      }
      
      if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL") {
        userResultHistory[userId] = [];
        settings.bs_wait_active = false;
        settings.bs_wait_remaining = 0;
      }

      if (settings.strategy === "DREAM") {
        settings.dream_state = {
          first_bet: true,
          current_pattern: "",
          current_index: 0
        };
      }
      
      if (settings.strategy === "ALINKAR" || settings.strategy === "MAY_BARANI") {
        userResultHistory[userId] = userResultHistory[userId] || [];
      }
      
      delete userSkippedBets[userId];
      userShouldSkipNext[userId] = false;
      delete userSLSkipWaitingForWin[userId];
      delete userDelayUntil[userId]; 
      userWaitingForResult[userId] = false;
      
      bettingWorker(userId, ctx, ctx.telegram);
      return;
    }
    
  
if (rawText.includes("🛡️ Stop")) {
  const settings = userSettings[userId] || {};
  
  if (!settings.running) {
    await ctx.reply("Bot Is Not Running!", makeMainKeyboard(true));
    return;
  }
  
  userStopInitiated[userId] = true;
  
  settings.running = false;
  
  delete userWaitingForResult[userId];
  delete userShouldSkipNext[userId];
  delete userSLSkipWaitingForWin[userId];
  delete userDelayUntil[userId];
  delete settings.trend_skip_reason;
  
  resetSkipPeriods(userId);
  
  if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL") {
    delete userResultHistory[userId];
    settings.bs_wait_active = false;
  }

  if (settings.strategy === "DREAM") {
    delete settings.dream_state;
  }
  
  settings.martin_index = 0;
  settings.dalembert_units = 1;
  settings.custom_index = 0;
  saveUserSettings();
  
  let totalProfit = 0;
  let finalBalance = 0;
  let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");
  
  if (settings.virtual_mode) {
    if (settings.admin_virtual_mode) {
      totalProfit = (userStats[userId]?.admin_virtual_balance || 0) - (userStats[userId]?.admin_start_balance || 0);
      finalBalance = userStats[userId]?.admin_virtual_balance || 0;
    } else {
      totalProfit = (userStats[userId]?.virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE;
      finalBalance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
    }
  } else {
    totalProfit = userStats[userId]?.profit || 0;
    try {
      const balance = await safeExecute(userId, () => getBalance(userSessions[userId], userId), 0);
      finalBalance = balance || 0;
    } catch (error) {
      finalBalance = 0;
    }
  }
  
  await sendBotStoppedMessageWithImage(ctx.telegram, userId, finalBalance.toFixed(2), Math.abs(totalProfit).toFixed(2));
  
  delete userStopInitiated[userId];
  return;
}
 
    if (rawText.includes("💣 Bet_Size")) {
      userState[userId] = { state: "INPUT_BET_SIZES" };
      await ctx.reply("Enter Bet Size📝\n\nExample: 100-200-300", makeMainKeyboard(true));
      return;
    }
    
  
    if (rawText.includes("🎮 Virtual/Real Mode")) {
      await ctx.reply("📝Select Mode📝", makeModeSelectionKeyboard());
      return;
    }
    
   
    if (rawText.includes("🏹 Profit Target")) {
      userState[userId] = { state: "INPUT_PROFIT_TARGET" };
      await ctx.reply("Enter Profit Target📝\n\nExample: 100000", makeMainKeyboard(true));
      return;
    }
    
 
    if (rawText.includes("🔥 Stop Loss Limit")) {
      userState[userId] = { state: "INPUT_STOP_LIMIT" };
      await ctx.reply("Enter Stop Loss Limit📝\n\nExample: 100000", makeMainKeyboard(true));
      return;
    }
    
  
    if (rawText.includes("🔄 Entry Layer")) {
      await ctx.reply("📝Select Entry Layer📝", makeEntryLayerKeyboard());
      return;
    }
    
 
    if (rawText.includes("💥 Bet_SL")) {
      await ctx.reply("📝Select SL Layer📝", makeSLLayerKeyboard());
      return;
    }
    
 
    if (rawText.includes("🚀 Anti/Martingale")) {
      await ctx.reply("📝Betting Strategy📝", makeBettingStrategyKeyboard());
      return;
    }
    
   
    if (rawText.includes("📊 TRX Checker")) {
      const currentHour = getMyanmarTime().getHours();
      
      if (currentHour < 6) {
        await ctx.reply("TRX Data is not available now, it's start at 6:00AM");
        return;
      }

      try {
        const stats = getTRXStats();
        
        if (stats.total === 0) {
          await ctx.reply("⚠️ No TRX results recorded yet for today. Please wait a few minutes.");
          return;
        }

        const imageBuffer = await createTRXImage(stats);
        
        if (imageBuffer) {
          await ctx.replyWithPhoto(
            { source: imageBuffer },
            { 
              caption: `📊 *TRX Daily Results*\nDate: ${stats.date}\nDaily reset at 12:00 AM`,
              parse_mode: 'Markdown',
              disable_notification: true
            }
          );
        } else {
           await ctx.reply(
            `📊 *TRX Daily Results*\n` +
            `Date: ${stats.date}\n` +
            `Total: ${stats.total}`,
            { parse_mode: 'Markdown', disable_notification: true }
          );
        }
      } catch (error) {
        logging.error(`TRX Checker Error: ${error.message}`);
      }
      return;
    }
    
    if (lines.length >= 2 && 
        lines[0].match(/^9\d{9,11}$/) &&
        lines[1].length >= 6) { 
      
      const username = lines[0];
      const password = lines[1];
      const selectedUrl = userTemp[userId]?.platformUrl || DEFAULT_BASE_URL;
      const platformName = userTemp[userId]?.platformName || "Default";

      await ctx.reply(`Checking Login on ${platformName}...`);
      
      const { response: res, session } = await loginRequest(username, password, selectedUrl);
      
      if (session) {
        const userInfo = await getUserInfo(session, userId);
        if (userInfo && userInfo.user_id) {
          const gameUserId = userInfo.user_id;
          
          const idMessage = `👤 **Your Game ID**: ${gameUserId}\n\n`;
          
          if (!allowed777bigwinIds.has(gameUserId)) {
            await ctx.reply(
              `${idMessage}🚫 **ခွင့်ပြုချက်မရှိသေးပါ။**\n\n` +
              `👉 **သင့်ရဲ့ Game ID ကို Admin ထံ ခွင့်ပြုချက်တောင်းပါ**\n\n` +
              `📞 **Admin**: @name44744`, 
              makeMainKeyboard(false)
            );
            return;
          }
          
          const existingSettings = userSettings[userId];
          
          userSessions[userId] = session;
          userGameInfo[userId] = userInfo;
          
          userLoginCredentials[userId] = { 
            phone: username, 
            password: password,
            apiUrl: selectedUrl 
          };
          
          saveUserCredentials(); 

          userSessionExpiry[userId] = Date.now() + (6 * 60 * 60 * 1000);
          
          if (!existingSettings) {
            userSettings[userId] = getDefaultUserSettings();
          } else {
            userSettings[userId] = {
              ...existingSettings
            };
          }
          
          const balance = await safeExecute(userId, () => getBalance(session, userId), 0);
          
          if (!userStats[userId]) {
            userStats[userId] = { start_balance: parseFloat(balance || 0), profit: 0.0 };
          } else {
            userStats[userId].start_balance = parseFloat(balance || 0);
            userStats[userId].profit = 0.0;
          }
          
          const balanceDisplay = balance !== null ? balance : 0.0;
          await ctx.reply(`✅ Login Successful (${platformName})\n🆔 User ID: ${userInfo.user_id},\n💶 Balance: ${balanceDisplay} Ks`, makeMainKeyboard(true));
           
          await showUserStats(ctx, userId);
        } else {
          await ctx.reply("Login failed: Could not get user info", makeMainKeyboard(false));
        }
      } else {
        const msg = res.msg || "Login မအောင်မြင်ပါ";
        await ctx.reply(`Login Error: ${msg}`, makeMainKeyboard(false));
      }
      
      delete userTemp[userId];
      return;
    }
    
    if (!await checkUserAuthorized(ctx)) {
      return;
    }
    
    try {
      const currentState = userState[userId]?.state;
      if (currentState === "INPUT_BET_SIZES") {
        let betSizes = [];
        if (lines.length === 1 && lines[0].includes('-')) {
          betSizes = lines[0].split('-')
            .map(s => s.trim())
            .filter(s => s.match(/^\d+$/))
            .map(Number);
        } else {
          betSizes = lines.filter(s => s.match(/^\d+$/)).map(Number);
        }
        
        if (betSizes.length === 0) {
          throw new Error("No valid numbers");
        }
        
        const settings = userSettings[userId];
        if (settings.betting_strategy === "D'Alembert" && betSizes.length > 1) {
          await ctx.reply(
            "❌ D'Alembert strategy အသုံးပြုထားခြင်းကြောင့်Bet Size ကို တစ်ခုသာရေးပေးရန်လိုအပ်ပါသည်\n" +
            "❌ Please enter only one number for unit size.\n" +
            "Example:\n100",
            makeMainKeyboard(true)
          );
          return;
        }
        
        userSettings[userId].bet_sizes = betSizes;
        userSettings[userId].dalembert_units = 1;
        userSettings[userId].martin_index = 0;
        userSettings[userId].custom_index = 0;
        saveUserSettings();
        
        let message = `BET SIZE: ${betSizes.join('-')} Ks`;
        if (settings.betting_strategy === "D'Alembert") {
          message += `\n📝 D'Alembert Bet Size : ${betSizes[0]} Ks`;
        }
                 
        await ctx.reply(message, makeMainKeyboard(true));
        delete userState[userId];
      } else if (currentState === "INPUT_BS_PATTERN") {
        const pattern = text.toUpperCase();
        if (pattern && pattern.split('').every(c => c === 'B' || c === 'S')) {
          userSettings[userId].pattern = pattern;
          userSettings[userId].pattern_index = 0;
          saveUserSettings();
          await ctx.reply(`BS Pattern: ${pattern}`, makeMainKeyboard(true));
          delete userState[userId];
        } else {
          await ctx.reply("Invalid pattern. Please use only B and S. Example: BSBSSB", makeMainKeyboard(true));
        }
      } else if (currentState === "INPUT_PROFIT_TARGET") {
        const target = parseFloat(lines.length >= 2 ? lines[1] : text);
        if (isNaN(target) || target <= 0) {
          throw new Error("Invalid profit target");
        }
        userSettings[userId].target_profit = target;
        saveUserSettings();
        await ctx.reply(`PROFIT TARGET: ${target} Ks`, makeMainKeyboard(true));
        delete userState[userId];
      } else if (currentState === "INPUT_STOP_LIMIT") {
        const stopLoss = parseFloat(lines.length >= 2 ? lines[1] : text);
        if (isNaN(stopLoss) || stopLoss <= 0) {
          throw new Error("Invalid stop loss");
        }
        userSettings[userId].stop_loss = stopLoss;
        saveUserSettings();
        await ctx.reply(`STOP LOSS LIMIT: ${stopLoss} Ks`, makeMainKeyboard(true));
        delete userState[userId];
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`, makeMainKeyboard(true));
    }
  });
  
  if (!result.success && result.message) {
    await ctx.reply(result.message);
  }
}

async function showUserStats(ctx, userId) {
  try {
    const session = userSessions[userId];
    const userInfo = userGameInfo[userId];
    const settings = userSettings[userId] || {};
    
    if (!userInfo) {
      await ctx.reply("❌ Failed to get user info. Please login again.", makeMainKeyboard(true));
      return;
    }
    
    const betSizes = settings.bet_sizes || [100];
    const strategy = settings.strategy || "CHANNEL_SIGNAL";
    const bettingStrategy = settings.betting_strategy || "Martingale";
    const gameType = settings.game_type || "TRX";
    const betType = settings.bet_type || "BS";
    
    let modeText = "Real";
    if (settings.admin_virtual_mode) {
      modeText = "Real (Admin)";
    } else if (settings.virtual_mode) {
      modeText = "Virtual";
    }
   
    let balance = 0;
    let totalProfit = 0;
    
    if (settings.virtual_mode) {
      if (settings.admin_virtual_mode) {
        balance = userStats[userId]?.admin_virtual_balance || 0;
        totalProfit = balance - (userStats[userId]?.admin_start_balance || 0);
      } else {
        balance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
        totalProfit = balance - VIRTUAL_BALANCE;
      }
    } else {
      if (session) {
        balance = await getBalance(session, userId) || 0;
        totalProfit = userStats[userId]?.profit || 0;
      } else {
        balance = 0;
        totalProfit = 0;
      }
    }
   
    let strategyDisplay = strategy;
    if (strategy === "CHANNEL_SIGNAL") {
      const channelName = savedChannels.find(ch => ch.id === settings.target_channel_id)?.name || "None";
      strategyDisplay = `${channelName}`;
    } else if (strategy === "BS_ORDER") {
      strategyDisplay = `BS Order (${settings.pattern || "Default"})`;
    } else if (strategy === "TREND_FOLLOW") {
      strategyDisplay = `Trend Follow V1`;
    } else if (strategy === "BREAKER") {
      strategyDisplay = `Breaker `;
    } else if (strategy === "DREAM") {
      strategyDisplay = "DREAM";
    } else if (strategy === "ALINKAR") {
      strategyDisplay = "ALINKAR";
    } else if (strategy === "MAY_BARANI") {
      strategyDisplay = "MAY BARANI";
    } else if (strategy === "COLOR_TREND") {
      strategyDisplay = "Color Trend";
    } else if (strategy === "CHAT_GPT") {
      strategyDisplay = "Chat GPT Pattern";
    }
    
    let bettingStrategyDisplay = bettingStrategy;
    
    const layerLimit = settings.layer_limit || 1;
    let entryLayerDesc = "Immediately";
    if (layerLimit === 2) entryLayerDesc = "Wait 1 loss";
    else if (layerLimit === 3) entryLayerDesc = "Wait 2 losses";
    else if (layerLimit >= 4) entryLayerDesc = `Wait ${layerLimit - 1} losses`;
    
    const slLayer = settings.sl_layer || 0;
    const consecutiveLosses = settings.consecutive_losses || 0;
    
    const loseSL = settings.lose_sl || 0;
    const loseSLConsecutive = settings.lose_sl_consecutive_losses || 0;
    
    const lossAlertLimit = settings.consecutive_loss_limit || 0;
    const currentLossCount = settings.consecutive_loss_count || 0;
    
    const direction = settings.bet_direction || "STRAIGHT";
    const directionText = direction === "STRAIGHT" ? "📊 Straight" : "📉 Reverse";
    
    const betTypeText = betType === "COLOR" ? "Color" : "Big/Small";
    const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
    
    let profitSign = totalProfit >= 0 ? "+" : "";
    
    const infoText = 
`╔════════════════════════╗
        🤖 ${platformName} BET BOT
╚════════════════════════╝

🆔 USER ID: ${userInfo.user_id || 'N/A'}
💰 BALANCE: ${balance.toFixed(2)} Ks ( ${modeText} )

━━━━━━━━━━━━━━━━━━━━━━
📝 STRATEGY SETTINGS:
├ Game      : ${gameType}
├ Bet Type  : ${betTypeText}
├ Strategy  : ${strategyDisplay} ( ${directionText} )
├ Bet Mode  : ${bettingStrategyDisplay}
└ Bet Sizes : ${betSizes.join(' / ')}

━━━━━━━━━━━━━━━━━━━━━━
⚙️ TRADING CONFIG:
├ Profit Target : ${settings.target_profit || 0} Ks
├ Stop Loss : ${settings.stop_loss || 0} Ks
├ SL Layer  : ${slLayer}${slLayer > 0 ? ` (${consecutiveLosses}/${slLayer})` : ' (Disabled)'}
├ Entry Layer : ${layerLimit} (${entryLayerDesc})
├ Lose SL   : ${loseSL > 0 ? loseSL + ` (${loseSLConsecutive}/${loseSL})` : 'Disabled'}
└ Loss Alert: ${lossAlertLimit > 0 ? lossAlertLimit + `x (${currentLossCount}/${lossAlertLimit})` : 'Disabled'}

━━━━━━━━━━━━━━━━━━━━━━
🤖 BOT STATUS: ${settings.running ? '🟢 RUNNING' : '🔴 STOPPED'}
━━━━━━━━━━━━━━━━━━━━━━`;

    await ctx.reply(infoText, { parse_mode: 'HTML', disable_notification: true });
    
  } catch (error) {
    logging.error(`showUserStats error for user ${userId}: ${error.message}`);
    await ctx.reply("❌ Error loading user stats. Please try again later.", makeMainKeyboard(true));
  }
}
async function getColorPrediction(userId) {
  try {
    if (!userResultHistory[userId]) {
      userResultHistory[userId] = [];
    }
    
    const history = userResultHistory[userId];
    const colorHistory = history.map(bs => {
      return bs === 'B' ? 'R' : 'G';
    });
    
    if (colorHistory.length === 0) {
      return { result: 'G', percent: '50.0' };
    }
    
    const lastColor = colorHistory[colorHistory.length - 1];
    
    const prediction = lastColor === 'G' ? 'R' : 'G';
    
    return { result: prediction, percent: '50.0' };
  } catch (error) {
    logging.error(`Error getting color prediction: ${error}`);
    return { result: 'G', percent: '50.0' };
  }
}

async function startAutoResultsForUser(userId, bot) {
  try {
    const session = userSessions[userId];
    const settings = userSettings[userId] || {};
    const gameType = settings.game_type || "TRX";
    
    if (!session) {
      logging.error(`No session found for user ${userId}`);
      return;
    }
    
    const initialResults = await updateUserResults(userId);
    if (!initialResults) return;
    
    if (userResultsMessages[userId]) {
      try {
        await bot.telegram.deleteMessage(userId, userResultsMessages[userId].messageId);
        logging.info(`User ${userId} Main menu ပြန်ရောက်လို့ live result message ဖျက်လိုက်ပြီ`);
      } catch (deleteError) {
        logging.warning(`User ${userId} အတွက် အဟောင်း message ဖျက်လို့မရဘူး: ${deleteError.message}`);
      }
      delete userResultsMessages[userId];
    }
    
    const message = await sendMessageWithRateLimit(bot, userId, initialResults, { parse_mode: 'HTML', disable_notification: true });
    
    userResultsMessages[userId] = {
      messageId: message.message_id,
      chatId: userId,
      lastResults: initialResults,
      gameType: gameType,
      lastUpdateTime: Date.now()
    };
    
    userLastResults[userId] = initialResults;
    
    logging.info(`Started auto-results for user ${userId} (${gameType})`);
    
  } catch (error) {
    logging.error(`Failed to start auto-results for ${userId}: ${error.message}`);
  }
}

async function updateUserResults(userId) {
  try {
    const session = userSessions[userId];
    if (!session) {
      return null;
    }
    
    const settings = userSettings[userId] || {};
    const gameType = settings.game_type || "TRX";
    
    let resultsData;
    
    if (gameType === "WINGO30S") {
      resultsData = await getWingoGameResults(session);
    } else {
      resultsData = await getTRXGameResultsNew(session, gameType);
    }

    if (resultsData && resultsData.code === 0 && resultsData.data && resultsData.data.list) {
      const results = resultsData.data.list.slice(0, 10);
      const formatted = await formatResults(results, gameType);
      
      return formatted;
    }
    
    return null;
  } catch (error) {
    logging.error(`User ${userId} results update error: ${error.message}`);
    return null;
  }
}

function normalizeText(text) {
  return text.normalize('NFKC').trim();
}

function computeUnitAmount(amt) {
  if (amt <= 0) return 1;
  const amtStr = String(amt);
  const trailingZeros = amtStr.length - amtStr.replace(/0+$/, '').length;
  
  if (trailingZeros >= 4) return 10000;
  if (trailingZeros === 3) return 1000;
  if (trailingZeros === 2) return 100;
  if (trailingZeros === 1) return 10;
  return Math.pow(10, amtStr.length - 1);
}

function formatMyanmarTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

async function formatResults(results, gameType) {
  if (!results || results.length === 0) return null;
  
  let formattedResults = `🗒 <b>${getGameTypeDisplayName(gameType)} - Live Results</b>\n`;
  
  if (gameType === "WINGO30S") {
    const wingoInfo = getWINGOCountdown();
    
    formattedResults += `⏳ Next Result: <b>${wingoInfo.remainingSeconds}s</b>\n`;
    formattedResults += `🕒 Myanmar Time: ${formatMyanmarTime(wingoInfo.myanmarTime)}\n`;
    
    const progress = Math.floor((wingoInfo.wingoSecond / 29) * 10);
    let progressBar = "";
    for (let i = 0; i < 10; i++) {
      progressBar += i < progress ? "🟥" : "░";
    }
    
    formattedResults += `📊 [${progressBar}] ${Math.floor((wingoInfo.wingoSecond / 29) * 100)}%\n`;
    
  } else if (gameType === "TRX") {
    const trxInfo = getTRXCountdown();
    
    formattedResults += `⏳ Next Result: <b>${trxInfo.remainingSeconds}s</b>\n`;
    formattedResults += `🕒 Myanmar Time: ${formatMyanmarTime(trxInfo.myanmarTime)}\n`;
    
    const progress = Math.floor((trxInfo.trxSecond / 60) * 10);
    let progressBar = "";
    for (let i = 0; i < 10; i++) {
      progressBar += i < progress ? "🟥" : "░";
    }
    
    formattedResults += `📊 [${progressBar}] ${Math.floor((trxInfo.trxSecond / 60) * 100)}%\n`;
  }
  
  formattedResults += `══════════════════════════════════════\n\n`;
  formattedResults += `<code>Period      Result</code>\n`;
  formattedResults += `<code>──────────  ────────</code>\n`;
  
  const numberEmojis = {
    0: "0️⃣", 1: "1️⃣", 2: "2️⃣", 3: "3️⃣", 4: "4️⃣",
    5: "5️⃣", 6: "6️⃣", 7: "7️⃣", 8: "8️⃣", 9: "9️⃣"
  };
  
  results.forEach((result, index) => {
    const number = result.number || "0";
    let period = result.issueNumber || result.issue || "N/A";
    period = period.toString();
    
    const shortPeriod = period.slice(-5);
    const colorNum = parseInt(number) % 10;
    
    let bigSmall = colorNum >= 5 ? "BIG" : "SMALL";
    let colorEmoji = "";
    
    if (colorNum === 0 || colorNum === 5) colorEmoji = "🟣";
    else if ([1, 3, 7, 9].includes(colorNum)) colorEmoji = "🟢";
    else colorEmoji = "🔴";
    
    const numberEmoji = numberEmojis[colorNum] || "0️⃣";
    
    if (index === 0) {
      formattedResults += `<code>${shortPeriod.padEnd(11, ' ')}${numberEmoji} ${colorEmoji} ${bigSmall} 🔥</code>\n`;
    } else {
      formattedResults += `<code>${shortPeriod.padEnd(11, ' ')}${numberEmoji} ${colorEmoji} ${bigSmall} </code>\n`;
    }
  });
  
  formattedResults += `\n`;
  
  if (gameType === "WINGO30S") {
    const wingoInfo = getWINGOCountdown();
    formattedResults += `⏰ <i>WINGO 30 Second System</i>\n`;
    if (wingoInfo.isNewPeriod) {
      formattedResults += `🎯 <b>NEW PERIOD STARTED!</b>\n`;
    }
  } else if (gameType === "TRX") {
    const trxInfo = getTRXCountdown();
    formattedResults += `⏰ <i>TRX 60Second System</i>\n`;
    if (trxInfo.isNewPeriod) {
      formattedResults += `🎯 <b>NEW PERIOD STARTED!</b>\n`;
    }
  }
  formattedResults += `⚡ DEVELOPED BY 𝘿𝙍𝙀𝘼𝙈 𝙎𝙔𝙎𝙏𝙀𝙆𝙆⚡️`;
  
  return formattedResults;
}

function getTRXCountdown() {
  const myanmarTime = getMyanmarTime();
  const currentSecond = myanmarTime.getSeconds();
  const trxSecond = currentSecond % 60;
  const remainingSeconds = 60 - trxSecond;
  
  const nextResultTime = new Date(myanmarTime.getTime() + (remainingSeconds * 1000));
  
  return {
    myanmarTime: myanmarTime,
    myanmarSecond: currentSecond,
    trxSecond: trxSecond,
    remainingSeconds: remainingSeconds,
    nextResultTime: nextResultTime,
    isNewPeriod: trxSecond === 0
  };
}

function getWINGOCountdown() {
  const myanmarTime = getMyanmarTime();
  const currentSecond = myanmarTime.getSeconds();
  const wingoSecond = currentSecond % 30;
  const remainingSeconds = 30 - wingoSecond;
  
  const nextResultTime = new Date(myanmarTime.getTime() + (remainingSeconds * 1000));
  
  return {
    myanmarTime: myanmarTime,
    myanmarSecond: currentSecond,
    wingoSecond: wingoSecond,
    remainingSeconds: remainingSeconds,
    nextResultTime: nextResultTime,
    isNewPeriod: wingoSecond === 0
  };
}

function getGameCountdown(gameType) {
  if (gameType === "WINGO30S") {
    return getWINGOCountdown();
  } else if (gameType === "TRX") {
    return getTRXCountdown();
  }
  return getWINGOCountdown();
}

// ========== WIN/LOSE CHECKER ==========

async function winLoseChecker(bot) {
  logging.info("Win/lose checker started");
  while (true) {
    try {
      for (const [userId, session] of Object.entries(userSessions)) {
        if (!session) continue;
        
        const settings = userSettings[userId] || {};
        const gameType = settings.game_type || "TRX";
        const betType = settings.bet_type || "BS";
        
      
        if (!settings.virtual_mode && !await ensureValidSessionMain(userId, bot)) {
          if (settings.running) {
            settings.running = false;
            try {
              await sendMessageWithRateLimit(bot, userId, "❌ Session expired. Please login again.", makeMainKeyboard(false));
            } catch (error) {
              logging.error(`Failed to send session expired message to ${userId}: ${error.message}`);
            }
          }
          continue;
        }
        
        let data = []; 
        if (gameType === "WINGO30S") {
          const wingoRes = await safeExecute(userId, () => getWingoGameResults(session), null);
          if (!wingoRes || wingoRes.code !== 0) {
            continue;
          }
          data = wingoRes.data?.list || [];
        } else {
          let issueRes = await safeExecute(userId, () => getGameIssueRequest(session, gameType), null);
          
          if (!issueRes || issueRes.code !== 0) {
            continue;
          }
          
          const settledItem = issueRes.data && issueRes.data.settled ? issueRes.data.settled : {};
          data = [settledItem];
        }
        
        let gameHistory = [];
        if (settings.strategy === "BREAKER") {
          gameHistory = await safeExecute(userId, () => getGameHistory(session, gameType), []);
        }
        
        if (userPendingBets[userId]) {
          for (const [currentIssue, betInfo] of Object.entries(userPendingBets[userId])) {
            let settled;
            if (gameType === "WINGO30S") {
              settled = data.find(item => item.issueNumber === currentIssue);
            } else {
              settled = data.find(item => item.issueNumber === currentIssue);
            }
            
            if (settled && settled.number !== undefined && settled.number !== null) {
              const [betChoice, amount, isVirtual] = betInfo;
              const number = parseInt(settled.number || "0") % 10;
              const bigSmall = number >= 5 ? "B" : "S";
              const color = numberToColor(number);
              
              let isWin;
              if (betType === "COLOR") {
                isWin = betChoice === color;
              } else {
                isWin = (betChoice === "B" && bigSmall === "B") || (betChoice === "S" && bigSmall === "S");
              }
              
              const isManualBet = userManualBetHistory[userId]?.some(
                bet => bet.period === currentIssue && bet.result === "PENDING"
              );
              
              if (isManualBet) {
                const winAmount = isWin ? amount * 0.96 : 0;
                await updateManualBetHistory(userId, currentIssue, betChoice, isWin, winAmount, amount);
               
                try {
                  const resultMsg = isWin ? 
                    `🎉 Manual Bet WIN! +${winAmount.toFixed(2)} Ks` :
                    `😢 Manual Bet LOSE -${amount.toFixed(2)} Ks`;
                  
                  await sendMessageWithRateLimit(bot, userId, resultMsg, { disable_notification: true });
                } catch (error) {
                  logging.error(`Failed to send manual bet notification: ${error.message}`);
                }
              }

              const loseSLValue = settings.lose_sl;
              if (loseSLValue && loseSLValue > 0) {
                if (!isWin) {
                  settings.lose_sl_consecutive_losses = (settings.lose_sl_consecutive_losses || 0) + 1;
                  logging.info(`User ${userId} - Lose SL: Consecutive losses increased to ${settings.lose_sl_consecutive_losses}`);
                  
                  if (settings.lose_sl_consecutive_losses >= loseSLValue && !settings.lose_sl_active) {
                    settings.lose_sl_active = true;
                    settings.lose_sl_skip_count = loseSLValue;
                    settings.lose_sl_skipped_count = 0;
                    
                    logging.info(`User ${userId} - Lose SL ${loseSLValue} triggered! Will skip next ${loseSLValue} periods.`);
                  }
                } else {
                  settings.lose_sl_consecutive_losses = 0;
                  settings.lose_sl_active = false;
                  settings.lose_sl_skip_count = 0;
                  settings.lose_sl_skipped_count = 0;
                  
                  logging.info(`User ${userId} - Win! Lose SL consecutive losses reset to 0.`);
                }
              }
              
              if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL" || settings.strategy === "ALINKAR" || settings.strategy === "MAY_BARANI") {
                if (!userResultHistory[userId]) {
                  userResultHistory[userId] = [];
                }
                userResultHistory[userId].push(bigSmall);
                if (userResultHistory[userId].length > 20) {
                  userResultHistory[userId] = userResultHistory[userId].slice(-20);
                }
              }
              
              if (settings.strategy === "DREAM" && settings.dream_state) {
                const dreamState = settings.dream_state;
                const resultNumber = number;
                
                if (dreamState.first_bet) {
                  dreamState.first_bet = false;
                  dreamState.current_pattern = dreamPatterns[resultNumber.toString()] || dreamPatterns["0"];
                  dreamState.current_index = 0;
                  logging.info(`DREAM: First bet done. Using pattern for ${resultNumber}: ${dreamState.current_pattern}`);
                } else {
                  if (isWin) {
                    dreamState.current_pattern = dreamPatterns[resultNumber.toString()] || dreamPatterns["0"];
                    dreamState.current_index = 0;
                    logging.info(`DREAM: Win! Switched to pattern for ${resultNumber}: ${dreamState.current_pattern}`);
                  } else {
                    dreamState.current_index = (dreamState.current_index + 1) % dreamState.current_pattern.length;
                    logging.info(`DREAM: Loss. Advanced to index ${dreamState.current_index} in pattern: ${dreamState.current_pattern}`);
                  }
                }
                saveUserSettings();
              }
            
              const lossAlertLimit = settings.consecutive_loss_limit;
              if (lossAlertLimit && lossAlertLimit > 0 && settings.running) {
                if (!isWin) {
                  settings.consecutive_loss_count = (settings.consecutive_loss_count || 0) + 1;
                  logging.info(`User ${userId} - Consecutive losses: ${settings.consecutive_loss_count}/${lossAlertLimit}`);
                  
                  if (settings.consecutive_loss_count >= lossAlertLimit) {
                    settings.alert_sent_for_this_streak = true;
                    saveUserSettings();
                  }
                } else {
                  if (settings.consecutive_loss_count > 0) {
                    logging.info(`User ${userId} - Win! Resetting consecutive loss counter from ${settings.consecutive_loss_count} to 0`);
                    await clearAlertForUser(bot, userId);
                  }
                  settings.consecutive_loss_count = 0;
                  settings.alert_sent_for_this_streak = false;
                  saveUserSettings();
                }
              }
              
              const entryLayer = settings.layer_limit || 1;
              let entryLayerProgress = "";
              
              if (entryLayer >= 2 && entryLayer <= 9 && settings.entry_layer_state) {
                  if (settings.entry_layer_state.waiting_for_loses) {
                    if (!isWin) {
                      settings.entry_layer_state.consecutive_loses = (settings.entry_layer_state.consecutive_loses || 0) + 1;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (${settings.entry_layer_state.consecutive_loses}/${settings.entry_layer_state.required_loses})`;
                      logging.info(`Entry Layer ${entryLayer}: Consecutive losses increased to ${settings.entry_layer_state.consecutive_loses} for user ${userId}`);
                      if (settings.entry_layer_state.consecutive_loses >= settings.entry_layer_state.required_loses) {
                        settings.entry_layer_state.waiting_for_loses = false;
                        settings.entry_layer_state.real_betting_started = true;
                        logging.info(`Entry Layer ${entryLayer}: Required ${settings.entry_layer_state.required_loses} consecutive losses reached! Starting real betting for user ${userId}`);
                      }
                    } else {
                      settings.entry_layer_state.consecutive_loses = 0;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (0/${settings.entry_layer_state.required_loses})`;
                      settings.entry_layer_state.waiting_for_loses = true;
                      settings.entry_layer_state.real_betting_started = false;
                      logging.info(`Entry Layer ${entryLayer}: Win during waiting period - reset consecutive losses to 0 for user ${userId}`);
                    }
                  } else if (settings.entry_layer_state.real_betting_started) {
                    if (isWin) {
                      settings.entry_layer_state.waiting_for_loses = true;
                      settings.entry_layer_state.consecutive_loses = 0;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (0/${settings.entry_layer_state.required_loses})`;
                      settings.entry_layer_state.real_betting_started = false;
                      logging.info(`Entry Layer ${entryLayer}: Win in real betting - reset entry layer completely for user ${userId}`);
                    }
                  }
              }
              
              if (!isWin) {
                settings.consecutive_losses = (settings.consecutive_losses || 0) + 1;
                
                if (settings.sl_layer && settings.consecutive_losses >= settings.sl_layer) {
                  userShouldSkipNext[userId] = true;
                  userSLSkipWaitingForWin[userId] = true;
                  logging.info(`SL Layer triggered for user ${userId}. Skipping next bet after ${settings.consecutive_losses} consecutive losses.`);
                }
              } else {
                settings.consecutive_losses = 0;
                
                if (userSLSkipWaitingForWin[userId]) {
                  delete userSLSkipWaitingForWin[userId];
                  userShouldSkipNext[userId] = false;
                  logging.info(`SL Layer reset for user ${userId} after a win. Next bet will follow betting strategy.`);
                }
              }

              updateBettingStrategy(settings, isWin, amount);
              
              if (isVirtual) {
                if (settings.admin_virtual_mode) {
                  if (!userStats[userId].admin_virtual_balance) {
                    userStats[userId].admin_virtual_balance = userStats[userId].admin_start_balance || 0;
                  }
                  if (isWin) {
                    userStats[userId].admin_virtual_balance += amount * 0.96;
                  } else {
                    userStats[userId].admin_virtual_balance -= amount;
                  }
                } else {
                  if (!userStats[userId].virtual_balance) {
                    userStats[userId].virtual_balance = VIRTUAL_BALANCE;
                  }
                  
                  if (isWin) {
                    userStats[userId].virtual_balance += amount * 0.96;
                  } else {
                    userStats[userId].virtual_balance -= amount;
                  }
                }
              } else {
                if (userStats[userId] && amount > 0) {
                  if (isWin) {
                    const profitChange = amount * 0.96;
                    userStats[userId].profit += profitChange;
                  } else {
                    userStats[userId].profit -= amount;
                  }
                }
              }
      
              const currentProfit = isVirtual 
                ? (settings.admin_virtual_mode 
                   ? (userStats[userId].admin_virtual_balance - userStats[userId].admin_start_balance)
                   : (userStats[userId].virtual_balance - VIRTUAL_BALANCE))
                : (userStats[userId]?.profit || 0);
              const targetProfit = settings.target_profit; 
              
              if (settings.running && targetProfit && currentProfit >= targetProfit) {
                logging.info(`User ${userId} - 💰 Profit Target [${targetProfit.toFixed(2)} Ks] Reached! Current Profit: ${currentProfit.toFixed(2)} Ks. Stopping bot.`);
    
                settings.running = false;

                try {
                    let finalBalance;
                    let totalProfitForImage = currentProfit;
                    let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");
                    
                    if (settings.virtual_mode) {
                        if (settings.admin_virtual_mode) {
                            finalBalance = userStats[userId].admin_virtual_balance || 0;
                        } else {
                            finalBalance = userStats[userId].virtual_balance || VIRTUAL_BALANCE;
                        }
                    } else {
                        const session = userSessions[userId];
                        const balance = await safeExecute(userId, () => getBalance(session, userId), 0);
                        finalBalance = balance || 0;
                    }
                    
                    await sendProfitTargetMessageWithImage(bot, userId, 
                        finalBalance.toFixed(2), 
                        targetProfit.toFixed(2), 
                        Math.abs(totalProfitForImage).toFixed(2),
                        modeText
                    );
                } catch (error) {
                    logging.error(`Failed to send profit target image to ${userId}: ${error.message}`);
                }
    
                delete userPendingBets[userId][currentIssue];
                if (Object.keys(userPendingBets[userId]).length === 0) {
                    delete userPendingBets[userId];
                }
                userWaitingForResult[userId] = false;
                continue; 
              }
             
              const currentBalance = isVirtual 
                ? (settings.admin_virtual_mode ? userStats[userId].admin_virtual_balance : userStats[userId].virtual_balance)
                : await safeExecute(userId, () => getBalance(session, parseInt(userId)), 0);
              
              const botStopped = await safeExecute(userId, () => checkProfitAndStopLoss(userId, bot), false);
              if (botStopped) {
                delete userPendingBets[userId][currentIssue];
                if (Object.keys(userPendingBets[userId]).length === 0) {
                  delete userPendingBets[userId];
                }
                userWaitingForResult[userId] = false;
                continue;
              }
              
              let message;
              const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
              let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");
              
              if (isWin) {
                const winAmount = amount * 0.96;
                const totalProfit = isVirtual 
                  ? (settings.admin_virtual_mode 
                     ? (userStats[userId].admin_virtual_balance - userStats[userId].admin_start_balance)
                     : (userStats[userId].virtual_balance - VIRTUAL_BALANCE))
                  : (userStats[userId]?.profit || 0);
                
                let profitIndicator = "";
                if (totalProfit > 0) {
                  profitIndicator = "+";
                } else if (totalProfit < 0) {
                  profitIndicator = "-";
                } else {
                  profitIndicator = "";
                }
                
                message = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n━━━━━━━━━━━━━━━━━━━\n⛳ Result: ${bigSmall} ( 🟩 WIN )${entryLayerProgress}\n━━━━━━━━━━━━━━━━━━━\n📊 Total :  ${currentBalance?.toFixed(2) || '0.00' } Ks\n📈 Profit: ${profitIndicator}${Math.abs(totalProfit).toFixed(2)} Ks\n━━━━━━━━━━━━━━━━━━━`;
              } else {
                const totalProfit = isVirtual 
                  ? (settings.admin_virtual_mode 
                     ? (userStats[userId].admin_virtual_balance - userStats[userId].admin_start_balance)
                     : (userStats[userId].virtual_balance - VIRTUAL_BALANCE))
                  : (userStats[userId]?.profit || 0);
                
                let profitIndicator = "";
                if (totalProfit > 0) {
                  profitIndicator = "+";
                } else if (totalProfit < 0) {
                  profitIndicator = "-";
                } else {
                  profitIndicator = "";
                }
                
                let slMessage = "";
                if (settings.sl_layer && settings.consecutive_losses >= settings.sl_layer) {
                  slMessage = `\n⚠️ SL Layer (${settings.sl_layer})! Next Bet Skip`;
                }
                
                message = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n━━━━━━━━━━━━━━━━━━━\n⛳ Result: ${bigSmall} ( 🟥 LOSE )${entryLayerProgress}\n━━━━━━━━━━━━━━━━━━━\n📊 Total :  ${currentBalance?.toFixed(2) || '0.00' } Ks\n📈 Profit: ${profitIndicator}${Math.abs(totalProfit).toFixed(2)} Ks\n━━━━━━━━━━━━━━━━━━━`;
              }
              
              try {
                await sendMessageWithRateLimit(bot, userId, message, { disable_notification: true });
                
                userDelayUntil[userId] = Date.now() + DELAY_AFTER_RESULT;
                logging.info(`Set ${DELAY_AFTER_RESULT/1000} second delay for user ${userId} after ${isWin ? 'WIN' : 'LOSE'} result`);
                
              } catch (error) {
                logging.error(`Failed to send result to ${userId}: ${error.message}`);
              }
              
              delete userPendingBets[userId][currentIssue];
              if (Object.keys(userPendingBets[userId]).length === 0) {
                delete userPendingBets[userId];
              }
              userWaitingForResult[userId] = false;
              
              logging.info(`Processed result for user ${userId}, issue ${currentIssue}: ${isWin ? 'WIN' : 'LOSE'}`);
            }
          }
        }
        
        if (userSkippedBets[userId]) {
          for (const [currentIssue, betInfo] of Object.entries(userSkippedBets[userId])) {
            let settled;
            if (gameType === "WINGO30S") {
              settled = data.find(item => item.issueNumber === currentIssue);
            } else {
              settled = data.find(item => item.issueNumber === currentIssue);
            }
            
            if (settled && settled.number !== undefined && settled.number !== null) {
              const [betChoice, isVirtual, skipReason, skipCount] = betInfo;
              const number = parseInt(settled.number || "0") % 10;
              const bigSmall = number >= 5 ? 'B' : 'S';
              const color = numberToColor(number);
              
              let isWin;
              if (betType === "COLOR") {
                isWin = betChoice === color;
              } else {
                isWin = (betChoice === 'B' && bigSmall === 'B') || (betChoice === 'S' && bigSmall === 'S');
              }
              

              if (skipReason && skipReason.includes("Lose SL")) {
                if (settings.lose_sl_active && settings.lose_sl_skip_count > 0) {
                  settings.lose_sl_skipped_count = (settings.lose_sl_skipped_count || 0) + 1;
                  
                  if (settings.lose_sl_skipped_count >= settings.lose_sl_skip_count) {
                    settings.lose_sl_active = false;
                    settings.lose_sl_skip_count = 0;
                    settings.lose_sl_skipped_count = 0;
                    settings.lose_sl_consecutive_losses = 0;
                    
                    logging.info(`User ${userId} - Lose SL skip completed. Returning to normal betting.`);
                  }
                }
              }
              
              if (settings.strategy === "TREND_FOLLOW" || settings.strategy === "CHAT_GPT" || settings.strategy === "CHANNEL_SIGNAL" || settings.strategy === "ALINKAR" || settings.strategy === "MAY_BARANI") {
                if (!userResultHistory[userId]) {
                  userResultHistory[userId] = [];
                }
                userResultHistory[userId].push(bigSmall);
                if (userResultHistory[userId].length > 20) {
                  userResultHistory[userId] = userResultHistory[userId].slice(-20);
                }
              }
              
              if (settings.strategy === "DREAM" && settings.dream_state) {
                const dreamState = settings.dream_state;
                const resultNumber = number;
                
                if (dreamState.first_bet) {
                  dreamState.first_bet = false;
                  dreamState.current_pattern = dreamPatterns[resultNumber.toString()] || dreamPatterns["0"];
                  dreamState.current_index = 0;
                  logging.info(`DREAM (skip): First bet done. Pattern for ${resultNumber}: ${dreamState.current_pattern}`);
                } else {
                  if (isWin) {
                    dreamState.current_pattern = dreamPatterns[resultNumber.toString()] || dreamPatterns["0"];
                    dreamState.current_index = 0;
                    logging.info(`DREAM (skip): Win! Pattern for ${resultNumber}: ${dreamState.current_pattern}`);
                  } else {
                    dreamState.current_index = (dreamState.current_index + 1) % dreamState.current_pattern.length;
                    logging.info(`DREAM (skip): Loss. Index ${dreamState.current_index}`);
                  }
                }
                saveUserSettings();
              }
             
              const entryLayer = settings.layer_limit || 1;
              let entryLayerProgress = "";
              
              if (entryLayer >= 2 && entryLayer <= 9 && settings.entry_layer_state) {
                  if (settings.entry_layer_state.waiting_for_loses) {
                    if (!isWin) {
                      settings.entry_layer_state.consecutive_loses = (settings.entry_layer_state.consecutive_loses || 0) + 1;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (${settings.entry_layer_state.consecutive_loses}/${settings.entry_layer_state.required_loses})`;
                      logging.info(`Entry Layer ${entryLayer}: Consecutive losses increased to ${settings.entry_layer_state.consecutive_loses} for user ${userId}`);
                      if (settings.entry_layer_state.consecutive_loses >= settings.entry_layer_state.required_loses) {
                        settings.entry_layer_state.waiting_for_loses = false;
                        settings.entry_layer_state.real_betting_started = true;
                        logging.info(`Entry Layer ${entryLayer}: Required ${settings.entry_layer_state.required_loses} consecutive losses reached! Starting real betting for user ${userId}`);
                      }
                    } else {
                      settings.entry_layer_state.consecutive_loses = 0;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (0/${settings.entry_layer_state.required_loses})`;
                      settings.entry_layer_state.waiting_for_loses = true;
                      settings.entry_layer_state.real_betting_started = false;
                      logging.info(`Entry Layer ${entryLayer}: Win during waiting period - reset consecutive losses to 0 for user ${userId}`);
                    }
                  } else if (settings.entry_layer_state.real_betting_started) {
                    if (isWin) {
                      settings.entry_layer_state.waiting_for_loses = true;
                      settings.entry_layer_state.consecutive_loses = 0;
                      entryLayerProgress = ` - Entry Layer ${entryLayer} (0/${settings.entry_layer_state.required_loses})`;
                      settings.entry_layer_state.real_betting_started = false;
                      logging.info(`Entry Layer ${entryLayer}: Win in real betting - reset entry layer completely for user ${userId}`);
                    }
                  }
              }
              
              if (!isWin) {
                settings.consecutive_losses = (settings.consecutive_losses || 0) + 1;
                
                if (settings.sl_layer && settings.consecutive_losses >= settings.sl_layer) {
                  userShouldSkipNext[userId] = true;
                  userSLSkipWaitingForWin[userId] = true;
                  logging.info(`SL Layer triggered for user ${userId}. Skipping next bet after ${settings.consecutive_losses} consecutive losses.`);
                }
              } else {
                settings.consecutive_losses = 0;
                
                if (userSLSkipWaitingForWin[userId]) {
                  delete userSLSkipWaitingForWin[userId];
                  userShouldSkipNext[userId] = false;
                  logging.info(`SL Layer reset for user ${userId} after a win. Next bet will follow betting strategy.`);
                }
              }
              

  let resultMessage;
  const totalWait = settings.bs_wait_count || 0;
  const platformName = getPlatformDisplayName(userLoginCredentials[userId]?.apiUrl || DEFAULT_BASE_URL);
  let modeText = settings.admin_virtual_mode ? "Real" : (settings.virtual_mode ? "Virtual" : "Real");
  
  if (skipReason && skipReason.includes("No Signal")) {
    resultMessage = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n━━━━━━━━━━━━━━━━━━━\n📡 ${skipReason}\n🎲 Result: ${bigSmall}•${number} (${isWin ? '🟢 WIN' : '🔴 LOSE'})${entryLayerProgress}\n━━━━━━━━━━━━━━━━━━━`;
  } else if (skipReason && skipReason.includes("Period Not Match")) {
    resultMessage = `🏰 ⟦${platformName}⟧ - ${getGameTypeDisplayName(gameType)} 🏇\n\n🆔 Period: ${formatPeriod(currentIssue)} ( ${modeText} )\n━━━━━━━━━━━━━━━━━━━\n📡 ${skipReason}\n🎲 Result: ${bigSmall}•${number} (${isWin ? '🟢 WIN' : '🔴 LOSE'})${entryLayerProgress}\n━━━━━━━━━━━━━━━━━━━`;
  } else if (skipReason && skipReason.includes("BS/SB Wait")) {
    if (isWin) {
      resultMessage = `🟢 WIN (Skip ${skipCount}/${totalWait})${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)}  ( ${modeText} ) => ${bigSmall}•${number}`;
    } else {
      resultMessage = `🔴 LOSE (Skip ${skipCount}/${totalWait})${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)} ( ${modeText} ) => ${bigSmall}•${number}`;
    }
  } else if (skipReason && skipReason.includes("Entry Layer")) {
    if (isWin) {
      resultMessage = `🟢 WIN${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)} ( ${modeText} ) => ${bigSmall}•${number}`;
    } else {
      resultMessage = `🔴 LOSE${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)} ( ${modeText} ) => ${bigSmall}•${number}`;
    }
  } else {
    resultMessage = isWin ? 
      `🟢 WIN ${skipReason || 'Skipped'}${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)} ( ${modeText} ) => ${bigSmall}•${number}` :
      `🔴 LOSE ${skipReason || 'Skipped'}${entryLayerProgress}\n🆔 ${getGameTypeDisplayName(gameType)}: ${formatPeriod(currentIssue)} ( ${modeText} ) => ${bigSmall}•${number}`;
  }
  
  try {
    await sendMessageWithRateLimit(bot, userId, resultMessage, { disable_notification: true });
    
    userDelayUntil[userId] = Date.now() + DELAY_AFTER_RESULT;
    logging.info(`Set ${DELAY_AFTER_RESULT/1000} second delay for user ${userId} after skipped bet result`);
    
  } catch (error) {
    logging.error(`Failed to send virtual result to ${userId}: ${error.message}`);
  }

              
              delete userSkippedBets[userId][currentIssue];
              if (Object.keys(userSkippedBets[userId]).length === 0) {
                delete userSkippedBets[userId];
              }
            }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, WIN_LOSE_CHECK_INTERVAL * 1000));
    } catch (error) {
      logging.error(`Win/lose checker error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

async function updateManualBetHistory(userId, currentIssue, betChoice, isWin, winAmount = 0, totalAmount) {
  try {
    if (!userManualBetHistory[userId]) {
      userManualBetHistory[userId] = [];
      return;
    }
    
    const pendingBetIndex = userManualBetHistory[userId].findIndex(
      bet => bet.period === currentIssue && bet.result === "PENDING"
    );
    
    if (pendingBetIndex !== -1) {
      userManualBetHistory[userId][pendingBetIndex].result = isWin ? "WIN" : "LOSE";
      userManualBetHistory[userId][pendingBetIndex].winAmount = isWin ? winAmount : 0;
      userManualBetHistory[userId][pendingBetIndex].settledTime = Date.now();
      
      logging.info(`Updated manual bet history for user ${userId}, period ${currentIssue}: ${isWin ? 'WIN' : 'LOSE'}`);
    }
  } catch (error) {
    logging.error(`Error updating manual bet history for ${userId}: ${error.message}`);
  }
}

// ========== GAME SYNC UPDATER ==========

async function GameSyncUpdater(bot) {
  logging.info("Game Sync Updater စတင်ပါပြီ (TRX + WINGO30S)");
  
  let previousTRXSecond = -1;
  let previousWINGOSecond = -1;
  
  while (true) {
    try {
      const currentTRXInfo = getTRXCountdown();
      const currentWINGOInfo = getWINGOCountdown();
      
      const currentTRXSecond = currentTRXInfo.trxSecond;
      const currentWINGOSecond = currentWINGOInfo.wingoSecond;
      
      if (currentTRXSecond !== previousTRXSecond) {
        previousTRXSecond = currentTRXSecond;
        
        for (const userId in userResultsMessages) {
          try {
            const userData = userResultsMessages[userId];
            if (!userData) continue;
            
            const settings = userSettings[userId] || {};
            const gameType = settings.game_type || "TRX";
            
            if (gameType !== "TRX") continue;
            
            await updateGameUserResults(userId, bot, gameType, currentTRXSecond);
            
          } catch (userError) {
            logging.error(`User ${userId} TRX update error: ${userError.message}`);
          }
        }
      }
      
      if (currentWINGOSecond !== previousWINGOSecond) {
        previousWINGOSecond = currentWINGOSecond;
        
        for (const userId in userResultsMessages) {
          try {
            const userData = userResultsMessages[userId];
            if (!userData) continue;
            
            const settings = userSettings[userId] || {};
            const gameType = settings.game_type || "TRX";
            
            if (gameType !== "WINGO30S") continue;
            
            await updateGameUserResults(userId, bot, gameType, currentWINGOSecond);
            
          } catch (userError) {
            logging.error(`User ${userId} WINGO update error: ${userError.message}`);
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      logging.error(`Game Sync Updater error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function updateGameUserResults(userId, bot, gameType, currentSecond) {
  try {
    const session = userSessions[userId];
    if (!session) return;
    
    const userData = userResultsMessages[userId];
    if (!userData) return;
    
    let shouldUpdate = false;
    
    if (gameType === "TRX") {
      shouldUpdate = 
        currentSecond === 0 ||
        currentSecond === 50 ||  
        currentSecond === 60;   
    } else if (gameType === "WINGO30S") {
      shouldUpdate = 
        currentSecond === 0 ||
        currentSecond === 25 ||     
        currentSecond === 30;   
    }
    
    if (!shouldUpdate) {
      return;
    }
    
    let resultsData;
    if (gameType === "WINGO30S") {
      resultsData = await safeExecute(userId, () => getWingoGameResults(session), null);
    } else {
      resultsData = await safeExecute(userId, () => getTRXGameResultsNew(session, gameType), null);
    }
    
    if (!resultsData || resultsData.code !== 0 || !resultsData.data || !resultsData.data.list) {
      return;
    }
    
    const results = resultsData.data.list.slice(0, 10);
    const newResultsHtml = await formatResults(results, gameType);
    
    if (!newResultsHtml) {
      return;
    }
    
    if (userData.lastResults === newResultsHtml) {
      userResultsMessages[userId].lastUpdateTime = Date.now();
      if (gameType === "TRX") {
        userResultsMessages[userId].lastTRXSecond = currentSecond;
      } else if (gameType === "WINGO30S") {
        userResultsMessages[userId].lastWINGOSecond = currentSecond;
      }
      return;
    }
    
    if (userData.messageId) {
      try {
        await bot.telegram.deleteMessage(userData.chatId, userData.messageId);
      } catch (deleteError) {}
    }
    
    const newMessage = await sendMessageWithRateLimit(bot, userId, newResultsHtml, { parse_mode: 'HTML', disable_notification: true });
    
    userResultsMessages[userId] = {
      messageId: newMessage.message_id,
      chatId: userId,
      lastResults: newResultsHtml,
      gameType: gameType,
      lastUpdateTime: Date.now(),
      lastTRXSecond: gameType === "TRX" ? currentSecond : null,
      lastWINGOSecond: gameType === "WINGO30S" ? currentSecond : null
    };
    
    logging.info(`User ${userId} ${gameType} updated at second ${currentSecond}`);
    
  } catch (error) {
    logging.error(`User ${userId} ${gameType} update error: ${error.message}`);
  }
}

// ========== MAIN FUNCTION ==========

function main() {
  loadAllowedUsers();
  loadSavedChannels(); 
  loadDreamPatterns(); 
  allUsers = loadAllUsers();
  loadUserSettings(); 
  loadUserCredentials(); 
  loadTRXData(); 
  verifyAndSyncWebsite();
  loadBypassUsers(); 
  
  setInterval(verifyAndSyncWebsite, 5 * 60 * 1000);
  startTRXLogger(); 
  
  const bot = new Telegraf(BOT_TOKEN);
  
  bot.start(cmdStartHandler);
  bot.command('allow', cmdAllowHandler);
  bot.command('remove', cmdRemoveHandler);
  bot.command('show', cmdShowHandler);
  bot.command('send', cmdSendHandler);
  bot.command('users', cmdUsersHandler);
  bot.command('signal', cmdSignalHandler);
  bot.command('addchannel', cmdAddChannelHandler); 
  bot.command('removechannel', cmdRemoveChannelHandler); 
  bot.command('addbypass', handleAddBypass);
  bot.command('removebypass', handleRemoveBypass);
  bot.command('adminbalance', handleAdminVirtualBalance);
  bot.on('callback_query', callbackQueryHandler);
  bot.on('text', textMessageHandler);
  
  bot.on('channel_post', async (ctx) => {
    await enhancedChannelPostHandler(ctx, bot);
  });
  
  restoreSessions(); 
  
  startChannelSignalMonitor(bot);
  
  winLoseChecker(bot).catch(error => {
    logging.error(`Win/lose checker failed: ${error.message}`);
  });

  GameSyncUpdater(bot);
  
  startBotHealthMonitor(bot);
  
  ensureBotContinuesRunning(bot);
  
  startContinuousAlertMonitor(bot);
 
  bot.launch().then(() => {
    logging.info('Bot started successfully');
    logging.info('📡 Enhanced Channel Signal System: ACTIVE (1-second monitoring)');
    logging.info(`📊 Configured channel sources: ${savedChannels.length}`);
    logging.info(`⏰ Signal expiry: 120 seconds (2 minutes)`);
    logging.info('📡 Real-time channel signal monitoring: ENABLED');
    logging.info('🔍 Period matching: Strict (last 5 digits)');
    logging.info('🔄 Auto-login system: ENABLED with Circuit Breaker (ONLY for REAL mode)');
    logging.info('💀 Lose SL System: ACTIVE (1-10)');
    logging.info('⚡ Real-time channel signal processing: ENABLED');
    logging.info('⏱️ Win/lose check interval: 1 second');
    logging.info('📡 Channel signal check: 1 second');
    logging.info('🎮 Manual Bet System: ACTIVE');
    logging.info('📊 Live Results System: ACTIVE (30-second updates)');
    logging.info('🖼️ Image Generation System: ENABLED (Canvas)');
    logging.info('💰 Admin Virtual Balance System: ACTIVE');
    logging.info('🔒 Command Lock System: ENABLED (Prevents button freezing)');
    logging.info('📨 Telegram Rate Limiter: ACTIVE');
    logging.info('⚠️ Loss Alert System: ACTIVE with 10-second persistence');
    logging.info('🛡️ Safe Execute Error Handler: ENABLED');
    logging.info('🔇 Notification Suppression: ENABLED (disable_notification: true)');
    logging.info('🌐 Public TRX API: ENABLED (No login required for results)');
    logging.info('💻 Virtual Mode: Auto-login disabled (uses public API)');
    logging.info('💰 Real Mode: Auto-login enabled with Circuit Breaker');
    logging.info('⏱️ Session Check Interval: 5 seconds');
    logging.info('🤖 Auto-Info Button Click: ENABLED (when logout detected)');
  }).catch(error => {
    logging.error(`Bot failed to start: ${error.message}`);
  });
  
  process.on('uncaughtException', (error) => {
    logging.error(`Uncaught Exception: ${error.message}`);
    logging.error(error.stack);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logging.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  });
 
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

if (require.main === module) {
  main();
}