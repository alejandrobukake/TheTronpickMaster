// src/modules/ConfigManager.js

import readline from 'readline/promises';
import logger from '../utils/logger.js';
import process from 'process';

// Variable para almacenar la configuración una vez cargada
let currentConfig = null;

/**
 * Hace una pregunta al usuario y devuelve la respuesta.
 * NOTA: La contraseña será VISIBLE al escribirla.
 * @param {readline.Interface} rl
 * @param {string} query
 * @param {boolean} [hideInput=false] - Ignorado en esta versión simple.
 * @returns {Promise<string>}
 */
async function askQuestion(rl, query, hideInput = false) {
  const answer = await rl.question(query);
  return answer.trim();
}

/**
 * Obtiene toda la configuración necesaria interactuando con el usuario.
 * @returns {Promise<object>}
 */
async function getConfigFromUser() {
  if (currentConfig) {
    return currentConfig;
  }

  logger.info('--- Required Configuration ---');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const config = {};

    // --- Tronpick Data ---
    config.emailUser = await askQuestion(rl, 'Enter your email address (for registration and verification): ');
    const usernameInput = await askQuestion(rl, `Enter desired username (max 16 char, or press Enter to generate from email): `);
    if (usernameInput) {
        config.tronpickUsername = usernameInput.substring(0, 16);
    } else {
        config.tronpickUsername = (config.emailUser.split('@')[0] || `user_${Date.now()}`).substring(0, 16);
        logger.info(`Username not provided, generated: ${config.tronpickUsername}`);
    }

    config.tronpickPassword = await askQuestion(rl, 'Enter the password you want to use for Tronpick (WILL BE VISIBLE!): ', true);
    const tronpickPasswordConfirm = await askQuestion(rl, 'Confirm Tronpick password (WILL BE VISIBLE!): ', true);
    if (config.tronpickPassword !== tronpickPasswordConfirm) {
      throw new Error('Tronpick passwords do not match.');
    }
    if (!config.tronpickPassword) {
      throw new Error('Tronpick password cannot be empty.');
    }

    // --- Optional Referral Code ---
    config.referrerCode = await askQuestion(rl, 'Enter referral code (Optional, press Enter to skip): ');
    if (!config.referrerCode) {
        logger.info('No referral code provided.');
    }

    config.withdrawalAddress = await askQuestion(rl, 'Enter your TRX wallet address for manual withdrawals: ');
    if (!config.withdrawalAddress) {
        throw new Error('Withdrawal address cannot be empty.');
    }
    // Basic TRX address validation
    if (!config.withdrawalAddress.startsWith('T') || config.withdrawalAddress.length !== 34) {
        logger.warn('Warning: The provided address may not be a valid TRX address. Please verify.');
    }

    // --- VPS Identifier ---
    config.vpsIdentifier = await askQuestion(rl, 'Enter a unique identifier for this VPS (letters/numbers only, e.g., GCP-PROD-01): ');
    if (!config.vpsIdentifier || !/^[a-zA-Z0-9_-]+$/.test(config.vpsIdentifier)) {
        logger.info('Invalid or no VPS identifier provided. Generating automatically...');
        config.vpsIdentifier = `VPS_${Date.now().toString().slice(-6)}`;
        logger.info(`Generated identifier: ${config.vpsIdentifier}`);
    }

    // --- Telegram Configuration ---
    logger.info('--- Telegram Configuration (Optional) ---');
    logger.info('You can skip this section by pressing Enter if you don\'t want Telegram notifications');
    
    config.telegramBotToken = await askQuestion(rl, 'Enter Telegram bot token (Press Enter to skip): ');
    config.telegramSystemChannelId = await askQuestion(rl, 'Enter System Notifications channel ID (Press Enter to skip): ');
    config.telegramMoneyChannelId = await askQuestion(rl, 'Enter Money Alerts channel ID (Press Enter to skip): ');

    if (!config.telegramBotToken) {
        logger.warn('No Telegram bot token provided. Notifications will be disabled.');
    }
    if (!config.telegramSystemChannelId) {
        logger.warn('No System Notifications channel ID provided. System notifications will be disabled.');
    }
    if (!config.telegramMoneyChannelId) {
        logger.warn('No Money Alerts channel ID provided. Money notifications will be disabled.');
    }

    // --- Email for IMAP ---
    config.emailAppPassword = await askQuestion(rl, 'Enter your email APPLICATION PASSWORD (WILL BE VISIBLE!): ', true);
    config.imapHost = await askQuestion(rl, 'Enter IMAP server host (e.g.: imap.gmail.com): ');
    const imapPortStr = await askQuestion(rl, 'Enter IMAP server port (usually 993 for TLS): ');
    config.imapPort = parseInt(imapPortStr, 10);
    if (isNaN(config.imapPort) || config.imapPort <= 0) {
      throw new Error('IMAP port must be a positive number.');
    }

    // --- Browser Data ---
    const defaultUserDataPath = './user-data';
    config.userDataDirPath = defaultUserDataPath;
    logger.info(`Using default path for browser data: ${config.userDataDirPath}`);

    config.headlessMode = false;
    config.enableTurnstile = true;

    logger.info('--- Configuration Summary ---');
    logger.info(`Email: ${config.emailUser}`);
    logger.info(`Tronpick Username: ${config.tronpickUsername}`);
    logger.info(`Referral Code: ${config.referrerCode || 'None'}`);
    logger.info(`IMAP Host: ${config.imapHost}:${config.imapPort}`);
    logger.info(`Tronpick Password: [CONFIGURED]`);
    logger.info(`Manual Withdrawal Address: ${config.withdrawalAddress}`);
    logger.info(`VPS ID: ${config.vpsIdentifier}`);
    logger.info(`Telegram Bot Token: ${config.telegramBotToken ? '[CONFIGURED]' : 'Not configured'}`);
    logger.info(`System Channel ID: ${config.telegramSystemChannelId ? '[CONFIGURED]' : 'Not configured'}`);
    logger.info(`Money Channel ID: ${config.telegramMoneyChannelId ? '[CONFIGURED]' : 'Not configured'}`);
    logger.info(`Browser Data Path: ${config.userDataDirPath}`);
    logger.info(`Headless Mode: ${config.headlessMode}`);
    logger.info(`Enable Turnstile: ${config.enableTurnstile}`);

    currentConfig = config;
    return config;

  } catch (error) {
    logger.error(`Error obtaining configuration: ${error.message}`);
    if (!rl.closed) {
      rl.close();
    }
    throw error;
  } finally {
    if (!rl.closed) {
         rl.close();
    }
  }
}

/**
 * Returns the previously loaded configuration.
 * @returns {object} The configuration object.
 */
function getConfig() {
  if (!currentConfig) {
    throw new Error('Configuration has not been loaded. Call getConfigFromUser() first.');
  }
  return currentConfig;
}

// Export necessary functions
export { getConfigFromUser, getConfig };