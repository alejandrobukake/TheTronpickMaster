// src/Orchestrator.js

import fs from 'fs/promises'; // For reading/writing state
import path from 'path';     // For file path handling
import process from 'process'; // For handling shutdown (Ctrl+C)
import logger from './src/utils/logger.js'; // Our configured logger
import { getConfigFromUser, getConfig } from './src/modules/ConfigManager.js';
import { launchBrowser, closeBrowser, getPage, navigateTo } from './src/modules/BrowserManager.js';
import { signUp, signIn } from './src/modules/AuthHandler.js';
import { verifyEmail, VerificationType } from './src/modules/EmailVerifier.js';
import { claimBonusFaucet, claimHourlyFaucet, hideSurveysSection, getAvailableBonusSpins } from './src/modules/FaucetClaimer.js';
import { playOneCycle, handleSeedAndRefresh, resetState, getErrorCounts, getCurrentPnL, resetPnL } from './src/modules/RoulettePlayer.js';
// import { initiateWithdrawal, finalizeWithdrawal } from './modules/WithdrawalHandler.js'; // Stubs for withdrawals
import { delay } from './src/utils/helpers.js'; // Pause function
import { notifySystemEvent, notifyMoneyEvent, SystemEventType, MoneyEventType, isTelegramConfigured } from './src/modules/TelegramNotifier.js';

// --- Application State Definitions ---
// Defines the different states the bot can go through
const State = {
    INITIALIZING: 'INITIALIZING',
    NEEDS_CONFIG: 'NEEDS_CONFIG',
    LOADING_STATE: 'LOADING_STATE',
    LAUNCHING_BROWSER: 'LAUNCHING_BROWSER',
    CHECKING_SESSION: 'CHECKING_SESSION',
    NEEDS_LOGIN: 'NEEDS_LOGIN',
    CHECKING_EMAIL_VERIFICATION_STATUS: 'CHECKING_EMAIL_VERIFICATION_STATUS',
    NEEDS_SIGNUP: 'NEEDS_SIGNUP',
    NEEDS_EMAIL_VERIFICATION_REGISTRATION: 'NEEDS_EMAIL_VERIFICATION_REGISTRATION',
    AWAITING_EMAIL_LINK: 'AWAITING_EMAIL_LINK',
    NEEDS_BONUS_CLAIM: 'NEEDS_BONUS_CLAIM',
    SAVING_SETUP_STATE: 'SAVING_SETUP_STATE',
    READY_TO_PLAY: 'READY_TO_PLAY',
    PLAYING_ROULETTE: 'PLAYING_ROULETTE',
    PAUSED_FOR_FAUCET: 'PAUSED_FOR_FAUCET',
    CLAIMING_HOURLY_FAUCET: 'CLAIMING_HOURLY_FAUCET',
    // --- Manual withdrawal states ---
    WITHDRAWAL_THRESHOLD_REACHED: 'WITHDRAWAL_THRESHOLD_REACHED',
    PAUSED_FOR_MANUAL_WITHDRAWAL: 'PAUSED_FOR_MANUAL_WITHDRAWAL',
    RESUMING_AFTER_WITHDRAWAL: 'RESUMING_AFTER_WITHDRAWAL',
    AUTHENTICATION_COMPLETE: 'AUTHENTICATION_COMPLETE',
    ERROR: 'ERROR',
    STOPPING: 'STOPPING',
    STOPPED: 'STOPPED'
};

// --- Global State and Control Variables ---
let currentState = State.INITIALIZING; // Current state, starts with INITIALIZING
let appState = { // Data that will be persisted in appState.json
    isInitialSetupComplete: false, // Was registration + verification + bonus ever completed?
    lastFaucetClaimTime: null, // Timestamp (in ms) of the last time the HOURLY faucet was claimed
    verificationAttempts: 0, // Verification attempt counter
    lastBonusClaimTime: null, // Timestamp of last bonus claim (for tracking purposes)
    rouletteCycles: 0, // Total number of roulette cycles played
    totalPnL: 0 // Total profit and loss from roulette
};
const MAX_VERIFICATION_ATTEMPTS = 3; // Maximum number of verification attempts
const VERIFICATION_RETRY_DELAY_MS = 120 * 1000; // 2 minutes wait between verification attempts
let rouletteStartTime = null; // Timestamp (ms) to control the 62-minute interval
let consecutiveRouletteErrors = 0; // Counter for consecutive errors in playOneCycle
const MAX_ROULETTE_ERRORS = 5; // Limit before trying to change client seed
const FAUCET_INTERVAL_MS = 62 * 60 * 1000; // 62-minute interval for hourly faucet
const STATE_FILE_PATH = path.resolve('./appState.json'); // File where state is saved
const FAUCET_URL = 'https://tronpick.io/faucet.php'; // Common URL
const LOGIN_URL = 'https://tronpick.io/login.php'; // Login URL
const SETTINGS_URL = 'https://tronpick.io/settings.php'; // Settings URL
const ROULETTE_URL = 'https://tronpick.io/roulette.php'; // Roulette URL
const WITHDRAWAL_URL = 'https://tronpick.io/withdraw.php'; // Withdrawal URL
// Fixed withdrawal parameters
const WITHDRAWAL_TRIGGER = 16.638300;  // Threshold at which withdrawal is triggered
const BALANCE_TO_KEEP = 1.638300;      // Balance to keep after withdrawal

// Variables para seguimiento de balance y notificaciones
let lastReportedHour = null;
let lastHourlyBalance = null;
let lastReportedBalanceRange = null; // Para tracking de cambios de nivel entero (2,3,4...)
let lastErrorMessage = ''; // Para guardar el último mensaje de error

// Add global variables for balance monitoring
let lastBalanceCheckTime = null;        // Last balance check timestamp
let referenceBalance = null;            // Reference balance for comparisons
let lastBalanceChangeTime = null;       // Last time the balance changed
const BALANCE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BALANCE_CHANGE_THRESHOLD = 0.002; // 0.2%

// Variables for manual withdrawal control
let withdrawalThresholdBalance = null;        // Balance when threshold was reached
let systemPausedForWithdrawal = false;       // Flag indicating system is paused for manual withdrawal
let manualWithdrawalDetected = false;        // Flag indicating manual withdrawal was detected

// --- Persistence Functions ---
/**
 * Loads application state from appState.json if it exists.
 * Updates the global `appState` variable.
 */
async function loadStateFromFile() {
    try {
        logger.info(`Loading state from ${STATE_FILE_PATH}...`);
        const data = await fs.readFile(STATE_FILE_PATH, 'utf-8');
        appState = JSON.parse(data);
        if (appState.lastFaucetClaimTime) {
            appState.lastFaucetClaimTime = new Date(appState.lastFaucetClaimTime).getTime();
        }
        if (appState.lastBonusClaimTime) {
            appState.lastBonusClaimTime = new Date(appState.lastBonusClaimTime).getTime();
        }
        if (appState.verificationAttempts === undefined) {
            appState.verificationAttempts = 0;
        }
        if (appState.rouletteCycles === undefined) {
            appState.rouletteCycles = 0;
        }
        if (appState.totalPnL === undefined) {
            appState.totalPnL = 0;
        }
        // Initialize withdrawal control variables if they don't exist
        if (appState.withdrawalThresholdBalance !== undefined) {
            withdrawalThresholdBalance = appState.withdrawalThresholdBalance;
        }
        if (appState.systemPausedForWithdrawal !== undefined) {
            systemPausedForWithdrawal = appState.systemPausedForWithdrawal;
        }
        logger.info('State loaded successfully.');
        logger.info(` - Initial Setup Complete: ${appState.isInitialSetupComplete}`);
        logger.info(` - Last Faucet Claimed: ${appState.lastFaucetClaimTime ? new Date(appState.lastFaucetClaimTime).toLocaleString() : 'Never'}`);
        logger.info(` - Last Bonus Claimed: ${appState.lastBonusClaimTime ? new Date(appState.lastBonusClaimTime).toLocaleString() : 'Never'}`);
        logger.info(` - Verification Attempts: ${appState.verificationAttempts}`);
        logger.info(` - Roulette Cycles: ${appState.rouletteCycles}`);
        logger.info(` - Total PnL: ${appState.totalPnL}`);
        logger.info(` - Withdrawal Threshold Balance: ${withdrawalThresholdBalance || 'Not set'}`);
        logger.info(` - System Paused For Withdrawal: ${systemPausedForWithdrawal}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn('State file (appState.json) not found. Assuming initial state.');
        } else {
            logger.error(`Error loading state from file: ${error.message}`);
        }
    }
}

/**
 * Saves current state (global `appState` variable) to appState.json.
 */
async function saveStateToFile() {
    try {
        logger.debug(`Saving state to ${STATE_FILE_PATH}...`);
        const stateToSave = {
            ...appState,
            lastFaucetClaimTime: appState.lastFaucetClaimTime ? new Date(appState.lastFaucetClaimTime).toISOString() : null,
            lastBonusClaimTime: appState.lastBonusClaimTime ? new Date(appState.lastBonusClaimTime).toISOString() : null,
            // Add withdrawal control state
            withdrawalThresholdBalance: withdrawalThresholdBalance,
            systemPausedForWithdrawal: systemPausedForWithdrawal,
        };
        const dataToSave = JSON.stringify(stateToSave, null, 2);
        await fs.writeFile(STATE_FILE_PATH, dataToSave, 'utf-8');
        logger.debug('State saved successfully.');
    } catch (error) {
        logger.error(`Error saving state to file: ${error.message}`);
    }
}

// --- Helper Functions ---
/**
 * Checks current TRX balance on the web page.
 * @returns {Promise<number>} The balance as a number, or 0 if an error occurs.
 */
async function checkBalance() {
    logger.info('Checking TRX balance...');
    const page = getPage();
    if (!page) {
        logger.error('Page not available.');
        return 0;
    }

    try {
        const balanceText = await page.$eval('span.user_balance', el => el.textContent.trim());
        const balance = parseFloat(balanceText.match(/(\d+\.\d+)/)?.[1] || '0');
        logger.info(`Current TRX balance: ${balance}`);
        return balance;
    } catch (error) {
        logger.error(`Error checking balance: ${error.message}`);
        return 0;
    }
}

/**
 * Closes verification notification messages on the page, including both
 * the "Your email has been successfully verified" message and
 * the "Thank you for registering. Please verify..." message.
 * @returns {Promise<boolean>} True if messages were closed, false if there were no messages to close
 */
async function dismissVerificationNotifications() {
    logger.info("Attempting to close verification notification messages...");
    const page = getPage();
    if (!page) {
        throw new Error("Page not available to close notifications.");
    }
    
    try {
        // Take screenshot before attempting to close for diagnostics
        try {
            const screenshotPath = path.resolve('./screenshots/before_dismiss_notifications.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            logger.info(`Screenshot before closing notifications: ${screenshotPath}`);
        } catch (screenshotError) {
            logger.warn(`Could not save diagnostic screenshot: ${screenshotError.message}`);
        }
        
        // Find all close buttons within alert messages
        const closeButtons = await page.$$('a.close.dismiss_noti_button');
        
        if (!closeButtons || closeButtons.length === 0) {
            logger.info("No notification close buttons found.");
            return false;
        }
        
        logger.info(`Found ${closeButtons.length} close buttons. Proceeding to close them...`);
        
        // Close each button in order, starting with the first
        let closedCount = 0;
        for (let i = 0; i < closeButtons.length; i++) {
            try {
                logger.info(`Clicking close button ${i+1}/${closeButtons.length}...`);
                await closeButtons[i].click();
                closedCount++;
                await delay(1000); // Wait for each close to process
            } catch (clickError) {
                logger.warn(`Error clicking button ${i+1}: ${clickError.message}`);
                
                // Plan B: Use evaluate if direct click fails
                try {
                    logger.info("Attempting alternative click with evaluate...");
                    await page.evaluate((index) => {
                        const buttons = document.querySelectorAll('a.close.dismiss_noti_button');
                        if (buttons[index]) {
                            buttons[index].click();
                        }
                    }, i);
                    logger.info("Alternative click executed.");
                    closedCount++;
                    await delay(1000);
                } catch (evalError) {
                    logger.error(`Error in alternative click: ${evalError.message}`);
                }
            }
        }
        
        // Take screenshot after to verify
        try {
            const screenshotPath = path.resolve('./screenshots/after_dismiss_notifications.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            logger.info(`Screenshot after closing notifications: ${screenshotPath}`);
        } catch (screenshotError) {
            logger.warn(`Could not save diagnostic screenshot: ${screenshotError.message}`);
        }
        
        logger.info(`Closed ${closedCount} of ${closeButtons.length} notifications.`);
        return closedCount > 0;
        
    } catch (error) {
        logger.error(`Error closing notifications: ${error.message}`);
        return false;
    }
}

/**
 * Attempts to identify if email needs verification by reviewing page content.
 * Also detects and closes successful verification messages to avoid unnecessary processing.
 * @returns {Promise<boolean>} True if verification is needed, false if not.
 */
async function needsEmailVerification() {
    logger.info("Checking if email verification is required...");
    const page = getPage();
    if (!page) {
        throw new Error("Page not available to check email verification need.");
    }

    // Ensure we're on the faucet page
    if (!page.url().includes('/faucet.php')) {
        logger.info("Navigating to faucet to check email status...");
        await navigateTo(FAUCET_URL);
        await delay(3000); // Wait for page to load completely
    }
    
    // Hide surveys section if present
    try {
        await hideSurveysSection();
    } catch (surveyError) {
        logger.warn(`Error hiding survey section: ${surveyError.message}`);
    }
    
    // Take screenshot for diagnostics
    try {
        const screenshotPath = path.resolve('./screenshots/verification_check.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Diagnostic screenshot saved to: ${screenshotPath}`);
    } catch (screenshotError) {
        logger.warn(`Could not save diagnostic screenshot: ${screenshotError.message}`);
    }
    
    // STEP 1: First check if there's a successful verification message
    try {
        // Specifically look for the message "Your email has been successfully verified"
        const successText = await page.evaluate(() => {
            const alerts = document.querySelectorAll('div.alert');
            for (const alert of alerts) {
                if (alert.textContent.includes('Your email has been successfully verified')) {
                    return alert.textContent.trim();
                }
            }
            return null;
        });
        
        if (successText) {
            logger.info(`DETECTED successful verification message!: "${successText}"`);
            logger.info("Email is already verified. Closing notification messages...");
            
            // Close notifications to avoid future confusion
            const notificationsClosed = await dismissVerificationNotifications();
            logger.info(`Result of closing notifications: ${notificationsClosed ? "Messages closed successfully" : "No messages were closed"}`);
            
            return false; // Email already verified, no verification needed
        }
    } catch (error) {
        logger.warn(`Error checking successful verification message: ${error.message}`);
        // Continue with other checks
    }

    // STEP 2: Look for the "verify" link to confirm if verification is needed
    const verifyLinkSelector = 'div.alert.alert-success a[href="https://tronpick.io/settings.php"]';
    
    try {
        // Look for the verification link
        logger.info(`Looking for verification link (${verifyLinkSelector})...`);
        const verifyLink = await page.waitForSelector(verifyLinkSelector, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        if (verifyLink) {
            // Try to get the complete message text for logging
            try {
                const alertMessage = await page.$eval('div.alert.alert-success', el => el.textContent.trim());
                logger.info(`Verification message found: "${alertMessage}"`);
            } catch (textError) {
                logger.info("Verification link found, but could not read the complete message.");
            }
            
            // IMPORTANT: DON'T close this message because we need it for verification
            return true; // Verification is needed
        }
    } catch (error) {
        logger.info(`No verification link found: ${error.message}`);
        
        // Check if there's any other indicator that the email is already verified
        try {
            const welcomeMessage = await page.$eval('h1, h2, h3, h4', el => el.textContent.trim());
            logger.info(`Page header: "${welcomeMessage}"`);
        } catch (headerError) {
            logger.debug("Could not read page header.");
        }
    }

    // If no verification link was found, check if we're properly logged in
    try {
        const isLoggedIn = await page.evaluate(() => {
            // Look for elements that confirm we're logged in (e.g., username, user options)
            return !!document.querySelector('.navbar-nav') || 
                   !!document.querySelector('a[href="/logout.php"]') ||
                   document.body.textContent.includes('EARN FREE TRX');
        });
        
        if (!isLoggedIn) {
            logger.warn("We may not be properly logged in. Check the session.");
        } else {
            logger.info("Confirmed: we are properly logged in, with no visible verification message.");
        }
    } catch (loginCheckError) {
        logger.warn(`Error checking login status: ${loginCheckError.message}`);
    }
    
    // If no verification link was found, check if we're properly logged in
    try {
        const isLoggedIn = await page.evaluate(() => {
            // Look for elements that confirm we're logged in (e.g., username, user options)
            return !!document.querySelector('.navbar-nav') || 
                   !!document.querySelector('a[href="/logout.php"]') ||
                   document.body.textContent.includes('EARN FREE TRX');
        });
        
        if (!isLoggedIn) {
            logger.warn("We may not be properly logged in. Check the session.");
        } else {
            logger.info("Confirmed: we are properly logged in, with no visible verification message.");
        }
    } catch (loginCheckError) {
        logger.warn(`Error checking login status: ${loginCheckError.message}`);
    }
    
    return false; // No verification need detected
}

/**
 * Ensures we're on the settings page and then clicks the 'Verify email' button.
 * This function is more robust than the previous flow and better handles errors.
 * @returns {Promise<boolean>} True if the button was clicked, false in case of error.
 */
async function goToSettingsAndClickVerify() {
    logger.info("Executing robust navigation to settings.php and click on verify email...");
    
    try {
        const page = getPage();
        if (!page) throw new Error("Page not available.");
        
        // 1. Ensure we're on the settings.php page
        logger.info("Navigating directly to settings.php...");
        await navigateTo(SETTINGS_URL);
        await delay(3000); // Wait for page to load completely
        
        // Verify we actually reached settings.php
        const currentUrl = page.url();
        if (!currentUrl.includes('/settings.php')) {
            throw new Error(`Could not reach settings.php. Current URL: ${currentUrl}`);
        }
        
        logger.info("Navigation to settings.php successful.");
        
        // Take screenshot for diagnostics
        const screenshotPath = path.resolve(`./screenshots/settings_page_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Settings.php screenshot saved to: ${screenshotPath}`);
        
        // 2. Find and click the verification button
        logger.info("Looking for 'Verify email' button...");
        const verifyButtonSelector = '#process_verify_email';
        
        try {
            // Wait for the button to be visible
            await page.waitForSelector(verifyButtonSelector, { state: 'visible', timeout: 15000 });
            
            // Use JavaScript to click the button (more robust)
            logger.info("Clicking 'Verify email' using JavaScript...");
            await page.evaluate((selector) => {
                const button = document.querySelector(selector);
                if (button) {
                    button.click();
                } else {
                    throw new Error("Button not found in evaluate.");
                }
            }, verifyButtonSelector);
            
            logger.info("Click on 'Verify email' button executed successfully.");
            
            // Wait for request to process
            await delay(2000);
            
            // Take post-click screenshot
            const postClickScreenshotPath = path.resolve(`./screenshots/after_verify_click_${Date.now()}.png`);
            await page.screenshot({ path: postClickScreenshotPath, fullPage: true });
            logger.info(`Post-click screenshot saved to: ${postClickScreenshotPath}`);
            
            // Increment attempt counter
            appState.verificationAttempts++;
            await saveStateToFile();
            logger.info(`Verification attempt #${appState.verificationAttempts} recorded.`);
            
            return true;
            
        } catch (buttonError) {
            logger.error(`Error with 'Verify email' button: ${buttonError.message}`);
            
            // Error screenshot
            const errorScreenshotPath = path.resolve(`./screenshots/verify_button_error_${Date.now()}.png`);
            await page.screenshot({ path: errorScreenshotPath, fullPage: true });
            logger.info(`Error screenshot saved to: ${errorScreenshotPath}`);
            
            // Try alternative click method as fallback
            try {
                logger.info("Attempting alternative click on 'Verify email' button...");
                await page.click(verifyButtonSelector, { force: true });
                logger.info("Alternative click completed.");
                
                // Increment counter even for alternative method
                appState.verificationAttempts++;
                await saveStateToFile();
                logger.info(`Verification attempt #${appState.verificationAttempts} recorded (alternative method).`);
                
                return true;
            } catch (altClickError) {
                logger.error(`Alternative click also failed: ${altClickError.message}`);
                return false;
            }
        }
        
    } catch (error) {
        logger.error(`Error in navigation to settings.php: ${error.message}`);
        return false;
    }
}

/**
 * Attempts to claim the hourly faucet with extended retry logic
 * and explicit 20-second wait for CAPTCHA resolution.
 * @returns {Promise<boolean>}
 */
async function attemptHourlyFaucetClaim() {
    logger.info("Starting hourly faucet claim process with 20-second CAPTCHA wait...");
    
    try {
        // Take before screenshot for diagnostics
        const beforeScreenshotPath = path.resolve(`./screenshots/before_hourly_claim_${Date.now()}.png`);
        const page = getPage();
        await page.screenshot({ path: beforeScreenshotPath, fullPage: true });
        logger.info(`Screenshot before hourly claim saved to: ${beforeScreenshotPath}`);

        // 1. Ensure we are on the faucet page
        if (!page.url().includes('/faucet.php')) {
            logger.info("Navigating to faucet page for hourly claim...");
            await navigateTo(FAUCET_URL);
            await delay(3000); // Wait for page to load
        }
        
        // 2. Hide surveys section
        try {
            await hideSurveysSection();
            logger.info("Survey section hidden successfully.");
        } catch (error) {
            logger.warn(`Could not hide survey section: ${error.message}`);
        }
        
        // 3. Wait explicitly 20 seconds for CAPTCHA to auto-resolve
        logger.info("Waiting 20 seconds for CAPTCHA to auto-resolve...");
        await delay(20000);
        
        // 4. Now attempt to claim the hourly faucet
        const claimResult = await claimHourlyFaucet();
        
        if (claimResult) {
            logger.info("Hourly faucet claimed successfully!");
            
            // Update state with claim time
            appState.lastFaucetClaimTime = Date.now();
            await saveStateToFile();
            logger.info(`Recorded hourly faucet claim time: ${new Date(appState.lastFaucetClaimTime).toLocaleString()}`);
            
            return true;
        } else {
            logger.warn("Hourly faucet claim function returned false.");
            return false;
        }
        
    } catch (error) {
        logger.error(`Error during hourly faucet claim attempt: ${error.message}`);
        return false;
    }
}

/**
 * Ejecuta la lógica del juego de ruleta, enfocándose en completar un solo ciclo
 * y manejando cualquier error resultante o cambios de semilla necesarios
 * @returns {Promise<{success: boolean, message: string}>} Resultado del ciclo de ruleta
 */
async function executeRouletteCycle() {
    logger.info("=== EJECUTANDO CICLO RULETA ===");
    try {
        await navigateTo(ROULETTE_URL);
        await delay(1000);

        const cycleResult = await playOneCycle();
        appState.rouletteCycles++;
        appState.totalPnL = getCurrentPnL();
        await saveStateToFile();

        const needsRefresh = await handleSeedAndRefresh(cycleResult);
        if (needsRefresh) {
            logger.info("Refresco realizado por handleSeedAndRefresh.");
            consecutiveRouletteErrors = 0;
            return { success: true, message: "Ciclo completado, refresco realizado." };
        }

        if (cycleResult.outcome !== 'error') {
            consecutiveRouletteErrors = 0;
            return { success: true, message: `Ciclo completado con resultado: ${cycleResult.outcome}` };
        } else {
            consecutiveRouletteErrors++;
            const message = `Error en ciclo de ruleta: ${cycleResult.message}. Errores consecutivos: ${consecutiveRouletteErrors}/${MAX_ROULETTE_ERRORS}`;
            logger.warn(message);

            if (consecutiveRouletteErrors >= MAX_ROULETTE_ERRORS) {
                logger.error(`Demasiados errores consecutivos (${consecutiveRouletteErrors}). Pausando ruleta.`);
                return { success: false, message };
            }

            return { success: true, message };
        }
    } catch (error) {
        logger.error(`Error inesperado durante ejecución de ciclo de ruleta: ${error.message}`);
        consecutiveRouletteErrors++;
        return {
            success: consecutiveRouletteErrors < MAX_ROULETTE_ERRORS,
            message: `Error inesperado: ${error.message}. Errores consecutivos: ${consecutiveRouletteErrors}/${MAX_ROULETTE_ERRORS}`
        };
    }
}

/**
 * Check if it's time to claim the hourly faucet
 * @returns {Promise<boolean>} True if it's time to claim the faucet
 */
async function isTimeForFaucetClaim() {
    // If lastFaucetClaimTime is not set, we should claim immediately
    if (appState.lastFaucetClaimTime === null) {
        logger.info("No previous faucet claim time recorded. Claiming now.");
        return true;
    }
    
    // Calculate time since last claim
    const now = Date.now();
    const timeSinceLastClaim = now - appState.lastFaucetClaimTime;
    
    // Check if enough time has passed (62 minutes)
    const isFaucetReady = timeSinceLastClaim >= FAUCET_INTERVAL_MS;
    
    if (isFaucetReady) {
        logger.info(`Faucet is ready to claim! Last claimed: ${new Date(appState.lastFaucetClaimTime).toLocaleString()} (${Math.floor(timeSinceLastClaim / 60000)} minutes ago)`);
    } else {
        const minutesUntilReady = Math.floor((FAUCET_INTERVAL_MS - timeSinceLastClaim) / 60000);
        const secondsUntilReady = Math.floor((FAUCET_INTERVAL_MS - timeSinceLastClaim) / 1000) % 60;

        logger.info(`Faucet not ready yet. Next claim available in ${minutesUntilReady} minutes and ${secondsUntilReady} seconds.`);
        logger.info(`Last claimed: ${new Date(appState.lastFaucetClaimTime).toLocaleString()}`);
    }
    
    return isFaucetReady;
}

/**
 * Check if balance has reached withdrawal threshold
 * @returns {Promise<boolean>} True if balance is greater than or equal to the withdrawal threshold
 */
async function isReadyForWithdrawal() {
    const balance = await checkBalance();
    const readyForWithdrawal = balance >= WITHDRAWAL_TRIGGER;

    if (readyForWithdrawal) {
        logger.info(`Balance (${balance} TRX) meets withdrawal threshold (${WITHDRAWAL_TRIGGER} TRX, will keep ${BALANCE_TO_KEEP} TRX).`);
    } else {
        logger.info(`Balance (${balance} TRX) below threshold (${WITHDRAWAL_TRIGGER} TRX).`);
    }
    return readyForWithdrawal;
}

/**
 * Determina el rango de balance entero (2,3,4...) para un balance dado
 * @param {number} balance El balance actual
 * @returns {number} El número entero del rango
 */
function getBalanceRange(balance) {
    return Math.floor(balance);
}

/**
 * Verifica si se debe notificar un cambio de balance por hora
 * @param {number} currentBalance Balance actual
 * @returns {Promise<boolean>} True si se notificó un cambio
 */
async function checkAndNotifyBalanceChange(currentBalance) {
    if (!isTelegramConfigured()) return false;
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentRange = getBalanceRange(currentBalance);
    
    if (lastReportedHour === null) {
        logger.debug(`Inicializando tracking de balance: ${currentBalance} TRX (hora: ${currentHour}, rango: ${currentRange})`);
        lastReportedHour = currentHour;
        lastHourlyBalance = currentBalance;
        lastReportedBalanceRange = currentRange;
        return false;
    }
    
    if (currentHour !== lastReportedHour) {
        logger.debug(`Cambio de hora detectado: ${lastReportedHour} -> ${currentHour}`);
        
        if (currentRange !== lastReportedBalanceRange) {
            logger.info(`Cambio de rango de balance detectado: ${lastReportedBalanceRange} -> ${currentRange}`);
            const pnl = currentBalance - lastHourlyBalance;
            logger.info(`PnL desde último reporte: ${pnl.toFixed(6)} TRX`);
            
            try {
                await notifyMoneyEvent(MoneyEventType.BALANCE_CHANGE, {
                    currentBalance: currentBalance,
                    previousBalance: lastHourlyBalance,
                    pnl: pnl
                });
                lastReportedBalanceRange = currentRange;
                lastReportedHour = currentHour;
                lastHourlyBalance = currentBalance;
                return true;
            } catch (notifyError) {
                logger.error(`Error al enviar notificación de cambio de balance: ${notifyError.message}`);
                lastReportedBalanceRange = currentRange;
                lastReportedHour = currentHour;
                lastHourlyBalance = currentBalance;
                return false;
            }
        }
        
        lastReportedHour = currentHour;
        lastHourlyBalance = currentBalance;
    }
    return false;
}

// Add function to monitor balance changes
async function checkAndNotifyBalanceChanges() {
    if (!isTelegramConfigured()) return;

    const now = Date.now();

    if (!lastBalanceCheckTime) {
        lastBalanceCheckTime = now;
        const initialBalance = await checkBalance();
        referenceBalance = initialBalance;
        lastBalanceChangeTime = now;

        try {
            await notifyMoneyEvent(MoneyEventType.BALANCE_INITIAL, {
                balance: initialBalance
            });
            logger.info(`Initial balance notification sent: ${initialBalance} TRX`);
        } catch (error) {
            logger.error(`Error sending initial balance notification: ${error.message}`);
        }

        return;
    }

    if (now - lastBalanceCheckTime < BALANCE_CHECK_INTERVAL_MS) {
        return;
    }

    lastBalanceCheckTime = now;
    const currentBalance = await checkBalance();

    if (referenceBalance === null) {
        referenceBalance = currentBalance;
        lastBalanceChangeTime = now;
        return;
    }

    const changePercentage = Math.abs((currentBalance - referenceBalance) / referenceBalance);

    if (changePercentage >= BALANCE_CHANGE_THRESHOLD) {
        const pnl = currentBalance - referenceBalance;

        try {
            await notifyMoneyEvent(MoneyEventType.BALANCE_CHANGE, {
                currentBalance: currentBalance,
                previousBalance: referenceBalance,
                pnl: pnl
            });

            logger.info(`Balance change notification sent: ${(changePercentage * 100).toFixed(4)}% change`);
            referenceBalance = currentBalance;
            lastBalanceChangeTime = now;
        } catch (error) {
            logger.error(`Error sending balance change notification: ${error.message}`);
        }
    } else {
        const inactiveTime = now - lastBalanceChangeTime;
        const inactiveMinutes = Math.floor(inactiveTime / 60000);

        if (inactiveTime >= BALANCE_CHECK_INTERVAL_MS) {
            try {
                await notifySystemEvent(SystemEventType.BALANCE_INACTIVITY, {
                    balance: currentBalance,
                    lastChangeTime: new Date(lastBalanceChangeTime).toLocaleString(),
                    inactiveMinutes: inactiveMinutes
                });

                logger.info(`Balance inactivity notification sent: ${inactiveMinutes} minutes without changes`);
                lastBalanceChangeTime = now;
            } catch (error) {
                logger.error(`Error sending inactivity notification: ${error.message}`);
            }
        }
    }
}

// Add function to detect manual withdrawal
/**
 * Detects if a manual withdrawal has been performed by comparing current balance
 * with the balance when withdrawal threshold was reached
 * @returns {Promise<boolean>} True if manual withdrawal detected, false otherwise
 */
async function detectManualWithdrawal() {
    if (!systemPausedForWithdrawal || withdrawalThresholdBalance === null) {
        return false;
    }
    
    const currentBalance = await checkBalance();
    const balanceReduction = withdrawalThresholdBalance - currentBalance;
    
    // Consider it a withdrawal if balance decreased by at least 10 TRX
    const WITHDRAWAL_DETECTION_THRESHOLD = 10.0;
    
    if (balanceReduction >= WITHDRAWAL_DETECTION_THRESHOLD) {
        logger.info(`Manual withdrawal detected! Balance reduced from ${withdrawalThresholdBalance} to ${currentBalance} TRX (reduction: ${balanceReduction.toFixed(6)} TRX)`);
        
        // Send notification about detected withdrawal
        try {
            if (isTelegramConfigured()) {
                await notifyMoneyEvent(MoneyEventType.WITHDRAWAL_SUCCESS, {
                    amount: balanceReduction,
                    newBalance: currentBalance,
                    address: getConfig().withdrawalAddress
                });
                logger.info("Manual withdrawal notification sent to Telegram.");
            }
        } catch (notifyError) {
            logger.error(`Error sending withdrawal notification: ${notifyError.message}`);
        }
        
        // Reset withdrawal control variables
        systemPausedForWithdrawal = false;
        withdrawalThresholdBalance = null;
        manualWithdrawalDetected = true;
        
        return true;
    }
    
    logger.debug(`No withdrawal detected. Current balance: ${currentBalance}, threshold balance: ${withdrawalThresholdBalance}, reduction: ${balanceReduction.toFixed(6)}`);
    return false;
}

// --- Main State Machine Logic ---
/**
 * Executes the main loop that controls the bot flow based on states.
 */
async function runStateMachine() {
    logger.info("Starting state machine...");

    // Main loop: runs while the state is not STOPPED
    while (currentState !== State.STOPPED) {
        logger.info(`--- Current State: ${currentState} ---`); // More visible state log
        try {
            // Execute logic based on current state
            switch (currentState) {
                case State.INITIALIZING:
                    logger.info("Orchestrator Started.");
                    currentState = State.NEEDS_CONFIG;
                    break;

                case State.NEEDS_CONFIG:
                    await getConfigFromUser(); // Wait for user config
                    const config = getConfig();
                    logger.info(`Using fixed withdrawal threshold of ${WITHDRAWAL_TRIGGER} TRX (keeping ${BALANCE_TO_KEEP} TRX).`);

                    // Move Telegram notification here after configuration is loaded
                    try {
                        if (isTelegramConfigured()) {
                            await notifySystemEvent(SystemEventType.BOT_STARTED, {
                                email: config.emailUser,
                                withdrawalAddress: config.withdrawalAddress
                            });
                            logger.info("Notificación de inicio enviada a Telegram.");
                        }
                    } catch (telegramError) {
                        logger.warn(`Error al enviar notificación de inicio del bot: ${telegramError.message}`);
                    }

                    currentState = State.LOADING_STATE;
                    break;

                case State.LOADING_STATE:
                    await loadStateFromFile(); // Load data from appState.json
                    currentState = State.LAUNCHING_BROWSER;
                    break;

                case State.LAUNCHING_BROWSER:
                    await launchBrowser(); // Start Chromium
                    currentState = State.CHECKING_SESSION; // Go to check session
                    break;

                case State.CHECKING_SESSION:
                    logger.info("Checking active session...");
                    const page = getPage();
                    if (!page) throw new Error("Page not available to check session.");
                    logger.debug(`Navigating to ${FAUCET_URL} to check session...`);
                    await navigateTo(FAUCET_URL); // Go to protected page
                    
                    // Hide surveys section immediately
                    try {
                        await hideSurveysSection();
                        logger.info("Successfully hidden surveys section on initial load.");
                    } catch (surveyError) {
                        logger.warn(`Error hiding surveys section: ${surveyError.message}`);
                    }
                    
                    // *** WAIT 30 SECONDS for possible initial block ***
                    logger.info("Waiting 30 seconds after navigating to faucet (for possible block)...");
                    await delay(30000);
                    const finalUrl = page.url(); // See final URL AFTER waiting
                    logger.info(`Final URL after attempting to access faucet and waiting: ${finalUrl}`);

                    if (finalUrl.includes('/faucet.php')) {
                        // If we're on faucet, there's a session
                        logger.info("Active session detected!");
                        // Proceed to check if email verification is needed
                        currentState = State.CHECKING_EMAIL_VERIFICATION_STATUS;
                    } else if (finalUrl.includes('/login.php')) {
                        // If redirected to login, no session
                        logger.info("No active session (redirected to login). Attempting to login...");
                        // Always try login first if no session
                        currentState = State.NEEDS_LOGIN;
                    } else {
                        // Unexpected URL, try waiting in case it's a block
                        logger.warn(`Unexpected URL (${finalUrl}). Assuming initial block. Waiting for redirect (up to 60s)...`);
                        try {
                            // Wait a long time for the possible block to resolve and redirect
                            await page.waitForNavigation({ waitUntil: 'load', timeout: 60000 });
                            const urlAfterWait = page.url();
                            logger.info(`URL after waiting for block: ${urlAfterWait}`);
                            // Re-evaluate state based on new URL
                            if (urlAfterWait.includes('/faucet.php')) {
                                logger.info("Initial block overcome, active session found.");
                                currentState = State.CHECKING_EMAIL_VERIFICATION_STATUS;
                            } else if (urlAfterWait.includes('/login.php')) {
                                logger.info("Initial block overcome, redirected to login.");
                                currentState = State.NEEDS_LOGIN;
                            } else {
                                throw new Error(`Persistent unexpected URL after waiting for block: ${urlAfterWait}`);
                            }
                        } catch (waitError) {
                            logger.error(`Timeout or error waiting after possible initial block: ${waitError.message}`);
                            currentState = State.ERROR;
                        }
                    }
                    break;

                case State.NEEDS_LOGIN:
                    logger.info("Attempting to login...");
                    try {
                        // Call signIn and wait for its boolean result
                        const loginSuccess = await signIn(); // Calls AuthHandler.signIn
                        if (loginSuccess) {
                            logger.info("Login successful.");
                            currentState = State.CHECKING_EMAIL_VERIFICATION_STATUS;
                        } else {
                            // If signIn completed but returned false (credential failure/10s timeout)
                            logger.warn("Login failed (signIn returned false). Proceeding to attempt registration...");
                            currentState = State.NEEDS_SIGNUP;
                        }
                    } catch (signInError) {
                        // If signIn threw an error during execution (e.g.: failed to fill/verify field)
                        logger.error(`Technical error during login attempt: ${signInError.message}`);
                        // *** RESTRICTION: DON'T go to signup if there was a technical failure in login ***
                        currentState = State.ERROR;
                    }
                    break;

                // --- STATE: Check if email verification is needed ---
                case State.CHECKING_EMAIL_VERIFICATION_STATUS: // CORRECTED IMPLEMENTATION
                    logger.info("Checking if email verification is needed...");
                    
                    try {
                        // Use helper function to detect verification need
                        const needsVerification = await needsEmailVerification();
                        
                        if (needsVerification) {
                            logger.info("Email verification needed has been detected.");
                            // Reset the attempt counter when a new verification need is detected
                            appState.verificationAttempts = 0;
                            await saveStateToFile();
                            currentState = State.NEEDS_EMAIL_VERIFICATION_REGISTRATION;
                        } else {
                            logger.info("No email verification need detected.");
                            
                            // Check if general setup was already completed
                            if (!appState.isInitialSetupComplete) {
                                logger.warn("Email appears verified, but setup wasn't complete. Proceeding to bonus...");
                                currentState = State.NEEDS_BONUS_CLAIM; // Go to bonus to complete setup
                            } else {
                                // Check if there are any available bonus spins even after setup is complete
                                logger.info("Checking for any available bonus spins...");
                                try {
                                    const bonusSpins = await getAvailableBonusSpins();
                                    if (bonusSpins > 0) {
                                        logger.info(`Found ${bonusSpins} available bonus spins. Going to claim them...`);
                                        currentState = State.NEEDS_BONUS_CLAIM;
                                    } else {
                                        logger.info("No bonus spins available. Email and setup complete. Ready to play.");
                                        currentState = State.CLAIMING_HOURLY_FAUCET; // Changed from AUTHENTICATION_COMPLETE
                                    }
                                } catch (spinCheckError) {
                                    logger.warn(`Error checking bonus spins: ${spinCheckError.message}. Proceeding anyway.`);
                                    currentState = State.CLAIMING_HOURLY_FAUCET; // Changed from AUTHENTICATION_COMPLETE
                                }
                            }
                        }
                    } catch (error) {
                        logger.error(`Error checking email status: ${error.message}`);
                        // In case of error, we'll try to verify anyway
                        logger.warn("Due to the error, I'll assume verification is needed to be safe.");
                        currentState = State.NEEDS_EMAIL_VERIFICATION_REGISTRATION;
                    }
                    break;

                case State.NEEDS_SIGNUP: // Reached if signIn returned false
                    logger.info("Starting registration process...");
                    let signupSuccess = false;
                    try {
                        signupSuccess = await signUp(); // Calls AuthHandler function
                        if (signupSuccess) {
                            // After successful signup, save state and then verify email
                            currentState = State.SAVING_SETUP_STATE;
                        } else {
                            // If signUp returns false (it threw an error internally and caught it there)
                            logger.error("Registration failed (signUp returned false).");
                            currentState = State.ERROR;
                        }
                    } catch (signUpError) {
                         // If signUp threw an error it didn't catch internally (rare)
                        logger.error(`Technical error during registration attempt: ${signUpError.message}`);
                        currentState = State.ERROR;
                    }
                    break;

                case State.SAVING_SETUP_STATE: // Reached AFTER successful signup
                    logger.info("Marking initial setup as completed and saving state...");
                    appState.isInitialSetupComplete = true; // Mark as completed
                    await saveStateToFile(); // Save to appState.json
                    // After saving, proceed to verify email
                    currentState = State.NEEDS_EMAIL_VERIFICATION_REGISTRATION;
                    break;

                case State.NEEDS_EMAIL_VERIFICATION_REGISTRATION: // IMPROVED IMPLEMENTATION
                    logger.info("Starting email verification process (robust navigation)...");
                    
                    // Check if we've exceeded the attempt limit
                    if (appState.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
                        logger.error(`Reached the limit of ${MAX_VERIFICATION_ATTEMPTS} verification attempts. Stopping the process.`);
                        currentState = State.ERROR;
                        break;
                    }
                    
                    try {
                        // Use robust method to go to settings.php and click verify
                        const verifyClicked = await goToSettingsAndClickVerify();
                        
                        if (verifyClicked) {
                            logger.info("Navigation and click successful. Proceeding to wait for email...");
                            
                            // Pause before starting email search
                            logger.info("Waiting 5 seconds to ensure the request was processed...");
                            await delay(5000);
                            
                            currentState = State.AWAITING_EMAIL_LINK;
                        } else {
                            throw new Error("Could not complete navigation and click on verify.");
                        }
                    } catch (error) {
                        logger.error(`Error during verification process: ${error.message}`);
                        currentState = State.ERROR;
                    }
                    break;
                
                case State.AWAITING_EMAIL_LINK: // IMPROVED IMPLEMENTATION
                    logger.info("Waiting and searching for verification email...");
                    try {
                        // Before searching, give time for the email to arrive
                        logger.info("Waiting 10 seconds to allow time for email to arrive...");
                        await delay(10000);
                        
                        // Call EmailVerifier.js function to search and process the email
                        logger.info("Starting IMAP search for verification email...");
                        const emailVerified = await verifyEmail(VerificationType.REGISTRATION);
                        
                        if (emailVerified) {
                            logger.info("Email verification completed successfully! Proceeding to claim bonus.");
                            // Reset attempt counter after successful verification
                            appState.verificationAttempts = 0;
                            await saveStateToFile();
                            currentState = State.NEEDS_BONUS_CLAIM;
                        } else {
                            logger.error("Failed to verify email for registration.");
                            
                            // Log the failed attempt
                            logger.warn(`This was verification attempt #${appState.verificationAttempts} of ${MAX_VERIFICATION_ATTEMPTS}.`);
                            
                            // Wait a significant time before retrying to avoid being banned
                            if (appState.verificationAttempts < MAX_VERIFICATION_ATTEMPTS) {
                                logger.warn(`Waiting ${VERIFICATION_RETRY_DELAY_MS/1000} seconds before retrying verification...`);
                                await delay(VERIFICATION_RETRY_DELAY_MS);
                                logger.info("Retrying verification process after waiting.");
                                currentState = State.NEEDS_EMAIL_VERIFICATION_REGISTRATION;
                            } else {
                                logger.error(`Reached the limit of ${MAX_VERIFICATION_ATTEMPTS} verification attempts. Stopping.`);
                                currentState = State.ERROR;
                            }
                        }
                    } catch (error) {
                        logger.error(`Error during email search/processing: ${error.message}`);
                        
                        // In case of error, also wait before retrying
                        if (appState.verificationAttempts < MAX_VERIFICATION_ATTEMPTS) {
                            logger.warn(`Error in attempt #${appState.verificationAttempts}. Waiting ${VERIFICATION_RETRY_DELAY_MS/1000} seconds before retrying...`);
                            await delay(VERIFICATION_RETRY_DELAY_MS);
                            currentState = State.NEEDS_EMAIL_VERIFICATION_REGISTRATION;
                        } else {
                            currentState = State.ERROR;
                        }
                    }
                    break;
                
                case State.NEEDS_BONUS_CLAIM: // ENHANCED IMPLEMENTATION
                    logger.info("Attempting to claim bonus faucet...");
                    try {
                        // First check if there are any bonus spins available
                        const bonusSpinsAvailable = await getAvailableBonusSpins();
                        
                        if (bonusSpinsAvailable > 0) {
                            logger.info(`Found ${bonusSpinsAvailable} bonus spins to claim!`);
                            
                            // Call the enhanced function that handles the complete process
                            const bonusClaimed = await claimBonusFaucet();
                            
                            if (bonusClaimed) {
                                logger.info("Bonus faucet claimed successfully!");
                                // Record the timestamp of successful bonus claim
                                appState.lastBonusClaimTime = Date.now();
                                await saveStateToFile();
                            } else { 
                                logger.warn("Failed to claim bonus faucet, but continuing..."); 
                            }
                        } else {
                            logger.info("No bonus spins available to claim. Skipping bonus claim.");
                        }
                        
                        // Ensure setup is marked as complete and save
                        if (!appState.isInitialSetupComplete) {
                            logger.info("Marking initial setup as completed (after bonus/verification).");
                            appState.isInitialSetupComplete = true;
                            await saveStateToFile();
                        }
                        
                        // Go directly to claim hourly faucet now
                        currentState = State.CLAIMING_HOURLY_FAUCET;
                    } catch (error) {
                        logger.error(`Error during bonus claim attempt: ${error.message}`);
                        // Despite the error, consider setup complete
                        if (!appState.isInitialSetupComplete) {
                            logger.info("Marking initial setup as completed despite bonus error.");
                            appState.isInitialSetupComplete = true;
                            await saveStateToFile();
                        }
                        // Try to claim hourly faucet anyway
                        currentState = State.CLAIMING_HOURLY_FAUCET;
                    }
                    break;

                case State.CLAIMING_HOURLY_FAUCET:
                    logger.info("Starting hourly faucet claim process...");
                    try {
                        // Try to claim hourly faucet with retry logic
                        const MAX_HOURLY_CLAIM_ATTEMPTS = 3;
                        let hourlyClaimAttempts = 0;
                        let hourlyClaimSuccess = false;
                        
                        while (hourlyClaimAttempts < MAX_HOURLY_CLAIM_ATTEMPTS && !hourlyClaimSuccess) {
                            hourlyClaimAttempts++;
                            logger.info(`Hourly faucet claim attempt ${hourlyClaimAttempts}/${MAX_HOURLY_CLAIM_ATTEMPTS}...`);
                            
                            // Use our helper function that includes the 20-second wait for CAPTCHA
                            hourlyClaimSuccess = await attemptHourlyFaucetClaim();
                            
                            if (hourlyClaimSuccess) {
                                logger.info(`Hourly faucet claimed successfully on attempt ${hourlyClaimAttempts}!`);
                                break;
                            } else if (hourlyClaimAttempts < MAX_HOURLY_CLAIM_ATTEMPTS) {
                                logger.warn(`Hourly claim attempt ${hourlyClaimAttempts} failed. Waiting 10 seconds before retry...`);
                                await delay(10000);
                            }
                        }
                        
                        if (hourlyClaimSuccess) {
                            // Record claim in log with human-readable time
                            const claimTimeString = new Date(appState.lastFaucetClaimTime).toLocaleString();
                            logger.info(`Successfully claimed hourly faucet at ${claimTimeString}`);
                            logger.info(`Next faucet claim will be available in 62 minutes (${FAUCET_INTERVAL_MS/60000} minutes).`);
                            
                            // Initialize rouletteStartTime when starting to play
                            rouletteStartTime = Date.now();
                            
                            // Now transition to playing roulette
                            currentState = State.PLAYING_ROULETTE;
                        } else {
                            logger.error(`Failed to claim hourly faucet after ${MAX_HOURLY_CLAIM_ATTEMPTS} attempts.`);
                            // Continue to playing roulette anyway - we'll try again later after 62 minutes
                            // Initialize rouletteStartTime even though claim failed
                            rouletteStartTime = Date.now();
                            currentState = State.PLAYING_ROULETTE;
                        }
                    } catch (error) {
                        logger.error(`Error during hourly faucet claim: ${error.message}`);
                        // Continue to playing roulette despite error
                        rouletteStartTime = Date.now();
                        currentState = State.PLAYING_ROULETTE;
                    }
                    break;
                
                case State.PLAYING_ROULETTE:
                    // First check if it's time to claim the faucet
                    if (await isTimeForFaucetClaim()) {
                        logger.info("Time to claim hourly faucet. Pausing roulette play...");
                        currentState = State.PAUSED_FOR_FAUCET;
                        break;
                    }
                    
                    // Then check if we've reached withdrawal threshold
                    if (await isReadyForWithdrawal()) {
                        logger.info("Withdrawal threshold reached. Pausing system for manual withdrawal...");
                        withdrawalThresholdBalance = await checkBalance();
                        systemPausedForWithdrawal = true;
                        currentState = State.WITHDRAWAL_THRESHOLD_REACHED;
                        break;
                    }
                    
                    // Execute a roulette cycle
                    const rouletteResult = await executeRouletteCycle();
                    
                    // Check if we should continue playing
                    if (rouletteResult.success) {
                        logger.info(`Roulette cycle completed: ${rouletteResult.message}`);
                        // Add a short delay between cycles (2-5 seconds)
                        const waitTime = 2000 + Math.floor(Math.random() * 2000);
                        logger.info(`Waiting ${(waitTime / 1000).toFixed(1)} seconds for next cycle...`);
                        await delay(waitTime);
                        
                        // Stay in PLAYING_ROULETTE state
                        currentState = State.PLAYING_ROULETTE;
                    } else {
                        logger.error(`Failure in executeRouletteCycle: ${rouletteResult.message}.`);
                        
                        // Reset internal RoulettePlayer state before continuing
                        resetState();
                        // Reset consecutive errors counter
                        consecutiveRouletteErrors = 0;
                        
                        // If error is related to too many failures, pause before trying again
                        logger.warn("Pausing roulette for 5 minutes due to repeated errors...");
                        await delay(5 * 60 * 1000); // 5 minute pause
                        logger.info("Resuming roulette gameplay after pause.");
                        
                        // Try again after the pause
                        currentState = State.PLAYING_ROULETTE;
                    }

                    try {
                        const currentBalance = await checkBalance();
                        await checkAndNotifyBalanceChange(currentBalance);
                    } catch (balanceCheckError) {
                        logger.warn(`Error checking balance for notifications: ${balanceCheckError.message}`);
                    }

                    if (rouletteResult.success && rouletteResult.message && rouletteResult.message.includes('outcome: loss')) {
                        try {
                            if (isTelegramConfigured()) {
                                await notifySystemEvent(SystemEventType.LEVEL_13_LOSS, {
                                    pnl: getCurrentPnL()
                                });
                                logger.info("Level 13 loss notification sent to Telegram.");
                            }
                        } catch (telegramError) {
                            logger.warn(`Could not send level 13 loss notification: ${telegramError.message}`);
                        }
                    }

                    try {
                        await checkAndNotifyBalanceChanges();
                    } catch (monitorError) {
                        logger.warn(`Error in balance monitoring: ${monitorError.message}`);
                    }
                    break;
                
                case State.PAUSED_FOR_FAUCET:
                    logger.info("Paused roulette gameplay to claim hourly faucet.");
                    
                    // Claim the faucet
                    try {
                        // Try to claim hourly faucet with retry logic
                        const MAX_HOURLY_CLAIM_ATTEMPTS = 3;
                        let hourlyClaimAttempts = 0;
                        let hourlyClaimSuccess = false;
                        
                        while (hourlyClaimAttempts < MAX_HOURLY_CLAIM_ATTEMPTS && !hourlyClaimSuccess) {
                            hourlyClaimAttempts++;
                            logger.info(`Hourly faucet claim attempt ${hourlyClaimAttempts}/${MAX_HOURLY_CLAIM_ATTEMPTS}...`);
                            
                            // Use our helper function that includes the 20-second wait for CAPTCHA
                            hourlyClaimSuccess = await attemptHourlyFaucetClaim();
                            
                            if (hourlyClaimSuccess) {
                                logger.info(`Hourly faucet claimed successfully on attempt ${hourlyClaimAttempts}!`);
                                break;
                            } else if (hourlyClaimAttempts < MAX_HOURLY_CLAIM_ATTEMPTS) {
                                logger.warn(`Hourly claim attempt ${hourlyClaimAttempts} failed. Waiting 10 seconds before retry...`);
                                await delay(10000);
                            }
                        }
                        
                        if (hourlyClaimSuccess) {
                            // Record claim in log with human-readable time
                            const claimTimeString = new Date(appState.lastFaucetClaimTime).toLocaleString();
                            logger.info(`Successfully claimed hourly faucet at ${claimTimeString}`);
                            logger.info(`Next faucet claim will be available in 62 minutes (${FAUCET_INTERVAL_MS/60000} minutes).`);
                        } else {
                            logger.error(`Failed to claim hourly faucet after ${MAX_HOURLY_CLAIM_ATTEMPTS} attempts.`);
                        }
                        
                        // Update rouletteStartTime regardless of claim success
                        rouletteStartTime = Date.now();
                        
                        // Resume roulette gameplay
                        currentState = State.PLAYING_ROULETTE;
                    } catch (error) {
                        logger.error(`Error during hourly faucet claim: ${error.message}`);
                        // Resume roulette gameplay despite error
                        rouletteStartTime = Date.now();
                        currentState = State.PLAYING_ROULETTE;
                    }
                    break;
                
                // --- NUEVOS CASES para retiro manual ---
                case State.WITHDRAWAL_THRESHOLD_REACHED:
                    logger.info("Withdrawal threshold reached. Notifying via Telegram and pausing roulette...");
                    
                    try {
                        if (isTelegramConfigured()) {
                            const config = getConfig();
                            const currentBalance = await checkBalance();
                            
                            // Get server IP for VNC connection info
                            let serverIP = 'UNKNOWN_IP';
                            try {
                                const { exec } = await import('child_process');
                                const { promisify } = await import('util');
                                const execAsync = promisify(exec);
                                const { stdout } = await execAsync('curl -s ifconfig.me');
                                serverIP = stdout.trim();
                            } catch (ipError) {
                                logger.warn(`Could not detect server IP: ${ipError.message}`);
                            }
                            
                            await notifySystemEvent(SystemEventType.WITHDRAWAL_THRESHOLD_REACHED, {
                                balance: currentBalance,
                                threshold: WITHDRAWAL_TRIGGER,
                                serverIP: serverIP,
                                vncPort: 5901,
                                vncPassword: '383360'
                            });
                            logger.info("Withdrawal threshold notification sent to Telegram.");
                        }
                        
                        // Transition to paused state
                        currentState = State.PAUSED_FOR_MANUAL_WITHDRAWAL;
                        
                    } catch (error) {
                        logger.error(`Error sending withdrawal threshold notification: ${error.message}`);
                        currentState = State.PAUSED_FOR_MANUAL_WITHDRAWAL;
                    }
                    break;

                case State.PAUSED_FOR_MANUAL_WITHDRAWAL:
                    logger.info("System paused for manual withdrawal. Only faucet claims will continue...");
                    
                    // Check if manual withdrawal was detected
                    if (await detectManualWithdrawal()) {
                        logger.info("Manual withdrawal detected. Preparing to resume system...");
                        currentState = State.RESUMING_AFTER_WITHDRAWAL;
                        break;
                    }
                    
                    // Check if it's time to claim the faucet
                    if (await isTimeForFaucetClaim()) {
                        logger.info("Time to claim hourly faucet while paused for withdrawal...");
                        
                        try {
                            const hourlyClaimSuccess = await attemptHourlyFaucetClaim();
                            if (hourlyClaimSuccess) {
                                logger.info("Hourly faucet claimed successfully during withdrawal pause.");
                            } else {
                                logger.warn("Failed to claim hourly faucet during withdrawal pause.");
                            }
                        } catch (error) {
                            logger.error(`Error claiming faucet during withdrawal pause: ${error.message}`);
                        }
                    }
                    
                    // Wait 30 seconds before checking again
                    await delay(30000);
                    
                    // Stay in this state until manual withdrawal is detected
                    currentState = State.PAUSED_FOR_MANUAL_WITHDRAWAL;
                    break;

                case State.RESUMING_AFTER_WITHDRAWAL:
                    logger.info("Resuming system after manual withdrawal...");
                    
                    try {
                        if (isTelegramConfigured()) {
                            const currentBalance = await checkBalance();
                            await notifySystemEvent(SystemEventType.SYSTEM_RESUMED, {
                                balance: currentBalance,
                                message: "System resumed after manual withdrawal. Roulette play restarted."
                            });
                            logger.info("System resumed notification sent to Telegram.");
                        }
                        
                        // Reset roulette start time
                        rouletteStartTime = Date.now();
                        
                        // Reset consecutive errors
                        consecutiveRouletteErrors = 0;
                        
                        // Reset PnL (optional - comment out if you want to keep cumulative PnL)
                        resetPnL();
                        
                        // Return to playing roulette
                        currentState = State.PLAYING_ROULETTE;
                        
                    } catch (error) {
                        logger.error(`Error during system resumption: ${error.message}`);
                        // Continue to roulette anyway
                        rouletteStartTime = Date.now();
                        currentState = State.PLAYING_ROULETTE;
                    }
                    break;

                // --- Temporary State to Stop (Should no longer be used - kept for compatibility) ---
                case State.AUTHENTICATION_COMPLETE:
                    logger.info("AUTHENTICATION FLOW COMPLETED!");
                    // Now we go directly to claiming hourly faucet instead of stopping
                    currentState = State.CLAIMING_HOURLY_FAUCET;
                    break;

                // --- Main Flow (ACTIVATED) ---
                case State.READY_TO_PLAY:
                    logger.info("READY_TO_PLAY state reached!");
                    logger.info("============================================================");
                    logger.info("          AUTHENTICATION & FAUCET CLAIMING COMPLETE         ");
                    logger.info("============================================================");
                    logger.info("The bot has successfully completed all initial setup steps:");
                    logger.info(" - Account authentication");
                    logger.info(" - Email verification");
                    logger.info(" - Bonus faucet claiming");
                    logger.info(" - Hourly faucet claiming");
                    logger.info("");
                    logger.info("Now starting roulette gameplay...");
                    logger.info("============================================================");
                    
                    // Initialize rouletteStartTime to begin the timing for faucet claims
                    rouletteStartTime = Date.now();
                    
                    // Reset consecutive errors counter
                    consecutiveRouletteErrors = 0;
                    
                    // Initialize PnL in RoulettePlayer
                    resetPnL();
                    
                    // Transition to actually playing roulette
                    currentState = State.PLAYING_ROULETTE;

                    try {
                        const initialBalance = await checkBalance();
                        referenceBalance = initialBalance;
                        lastBalanceCheckTime = Date.now();
                        lastBalanceChangeTime = Date.now();
                
                        logger.info(`Balance monitoring initialized with balance: ${initialBalance} TRX`);
                
                        if (isTelegramConfigured()) {
                            await notifyMoneyEvent(MoneyEventType.BALANCE_INITIAL, {
                                balance: initialBalance
                            });
                            logger.info("Initial balance notification sent to Money channel");
                        }
                    } catch (error) {
                        logger.warn(`Error initializing balance monitoring: ${error.message}`);
                    }
                    break;

                // --- Final States ---
                case State.ERROR:
                    logger.error("A critical error has occurred. Stopping the orchestrator.");
                    currentState = State.STOPPING;

                    try {
                        if (isTelegramConfigured()) {
                            await notifySystemEvent(SystemEventType.CRITICAL_ERROR, {
                                message: lastErrorMessage
                            });
                            logger.info("Notificación de error crítico enviada a Telegram.");
                        }
                    } catch (telegramError) {
                        logger.warn(`Error al enviar notificación de error crítico: ${telegramError.message}`);
                        // Continuar con el flujo de cierre
                    }
                    break;

                case State.STOPPING:
                    logger.info("Starting shutdown sequence...");
                    await closeBrowser();
                    logger.info("Orchestrator stopped.");

                    try {
                        if (isTelegramConfigured()) {
                            await notifySystemEvent(SystemEventType.BOT_STOPPED, {
                                reason: "Parada controlada"
                            });
                            logger.info("Notificación de parada del bot enviada a Telegram.");
                        }
                    } catch (telegramError) {
                        logger.warn(`Error al enviar notificación de parada del bot: ${telegramError.message}`);
                        // Continuar con el cierre
                    }
                    currentState = State.STOPPED;
                    break;

                default:
                    logger.error(`Unknown state reached: ${currentState}. Stopping.`);
                    currentState = State.ERROR;
            } // End switch
        } catch (error) {
            // Catch unhandled errors within 'case' statements or thrown by functions
            logger.error(`Uncaught error in state ${currentState}: ${error.message}`);
             // Log stack trace only for unexpected errors
             if (!error.message.startsWith('Registration failed') && !error.message.includes('Login failed') && !error.message.includes('Critical failure') && !error.message.includes('Verification failed')) {
                logger.error(error.stack);
             }
            currentState = State.ERROR; // Go to error state

            lastErrorMessage = error.message;
            try {
                if (isTelegramConfigured() && !error.message.startsWith('Registration failed') && 
                    !error.message.includes('Login failed') && !error.message.includes('Verification failed')) {
                    await notifySystemEvent(SystemEventType.UNHANDLED_ERROR, {
                        state: currentState,
                        message: error.message
                    });
                    logger.info("Notificación de error no manejado enviada a Telegram.");
                }
            } catch (telegramError) {
                logger.warn(`No se pudo enviar notificación de error: ${telegramError.message}`);
            }
        } // End try-catch
        // Short pause between state machine cycles
        if (currentState !== State.STOPPED) {
            await delay(250);
        }
    } // End while
    logger.info("State machine finished.");
} // End runStateMachine

/**
 * Starts the application and configures orderly shutdown handling (Ctrl+C).
 */
async function start() {
    logger.info('=============================================');
    logger.info('========= Starting TronpickMaster ==========');
    logger.info('=============================================');

    // Handle SIGINT signal (Ctrl+C) for clean shutdown
    process.on('SIGINT', async () => {
        logger.warn('SIGINT received (Ctrl+C). Starting orderly shutdown...');
        if (currentState !== State.STOPPING && currentState !== State.STOPPED) {
            currentState = State.STOPPING;
            await delay(2000);
            if (currentState !== State.STOPPED) {
                logger.warn("Orderly shutdown didn't finish in time. Forcing close...");
                await closeBrowser();
                process.exit(1);
            } else {
                process.exit(0);
            }
        } else {
            process.exit(0);
        }
    });

    await runStateMachine();
    logger.info("runStateMachine execution completed.");
}

// Export the start function to be called from index.js
export { start };
