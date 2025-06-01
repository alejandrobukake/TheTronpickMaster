// src/modules/AuthHandler.js

import fs from 'fs/promises'; // For file system operations (creating directory)
import path from 'path';     // For path handling
import logger from '../utils/logger.js'; // Our configured logger
import { getPage, navigateTo } from './BrowserManager.js'; // Functions to control the browser
import { getConfig } from './ConfigManager.js'; // To get email, password, etc.
import { delay } from '../utils/helpers.js'; // Pause function

// Important URLs
const SIGNUP_URL = 'https://tronpick.io/signup.php';
const LOGIN_URL = 'https://tronpick.io/login.php';
const FAUCET_URL = 'https://tronpick.io/faucet.php'; // Success URL post-registration/login
const SCREENSHOTS_DIR = path.resolve('./screenshots'); // Folder to save error screenshots

// CSS key selectors (based on HTML and your feedback)
const SELECTORS = {
    // Signup & Login (some are shared)
    usernameInput: '#username', // Only in Signup
    emailInput: '#user_email', // Shared ID for email in login and signup
    passwordInput: '#password', // Shared ID for password in login and signup
    confirmPasswordInput: '#rpassword', // Only in Signup
    referrerInput: '#referrer', // Only in Signup (for scroll and optional)
    captchaDiv: '#cf_turnstile', // Cloudflare Turnstile div (on both pages)
    captchaResponseInput: 'input[name="cf-turnstile-response"]', // Hidden input (on both) - NOT VERIFIED IN LOGIN
    signupButton: '#process_signup', // Signup button
    loginButton: '#process_login', // Login button
    // Generic error message (may appear on both pages)
    errorMessageContainer: 'div.alert.alert-danger, div.alert.alert-warning',
};

/**
 * Helper: Waits for an element to be visible on the page,
 * scrolls (if indicated) to ensure it's centered in the view,
 * and returns the element handle. Throws an error if it fails.
 * @param {import('puppeteer').Page} page - Puppeteer page instance.
 * @param {string} selector - CSS selector of the element.
 * @param {boolean} [needsScroll=true] - Indicates whether scrolling should be attempted.
 * @param {number} [timeout=30000] - Maximum wait time in milliseconds.
 * @returns {Promise<import('puppeteer').ElementHandle>} - The handle of the found and visible element.
 */
async function waitAndEnsureVisible(page, selector, needsScroll = true, timeout = 30000) {
    logger.debug(`Waiting for ${selector} to be visible (timeout: ${timeout}ms, scroll: ${needsScroll})...`);
    // 1. Wait for the element to be present and visible
    await page.waitForSelector(selector, { state: 'visible', timeout: timeout });
    logger.debug(`Element ${selector} found and initially visible.`);
    // 2. Get the element handle
    const elementHandle = await page.$(selector);
    if (!elementHandle) {
        // This shouldn't happen if waitForSelector succeeded, but it's a good check
        throw new Error(`Element handle not found for ${selector} after waiting for visibility.`);
    }
    // 3. Scroll if required
    if (needsScroll) {
        logger.debug(`Scrolling to ${selector}...`);
        await elementHandle.evaluate(node => {
            node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        });
        await delay(600); // Increased post-scroll pause
        // Re-verify visibility after scrolling
        try {
            await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
             logger.debug(`Element ${selector} confirmed visible after scroll.`);
        } catch (e) {
            logger.warn(`Element ${selector} might not be fully visible after scroll check, continuing...`);
        }
    } else {
         logger.debug(`Skipping scroll for ${selector}.`);
    }
    return elementHandle;
}

/**
 * Helper: Waits, scrolls (optional), focuses, sets value with evaluate ("paste") and strictly verifies.
 * Retries once if verification fails. Throws an error if it ultimately fails.
 * @param {import('puppeteer').Page} page
 * @param {string} selector
 * @param {string} valueToSet
 * @param {string} fieldName - Descriptive name for logging.
 * @param {boolean} [needsScroll=true] - Indicates whether to scroll to the element.
 * @param {number} [timeout=60000]
 */
async function waitScrollSetValueAndVerifyStrict(page, selector, valueToSet, fieldName, needsScroll = true, timeout = 60000) {
    // Don't try to fill if the value is null or empty
    if (valueToSet === null || valueToSet === undefined || valueToSet === '') {
        logger.info(`Skipping field ${fieldName} as no value was provided.`);
        return; // Exit if there's nothing to fill
    }

    logger.info(`Processing field: ${fieldName} (${selector})...`);
    // 1. Wait and scroll (if applicable) to the element
    const elementHandle = await waitAndEnsureVisible(page, selector, needsScroll, timeout);

    let attempts = 0;
    const maxAttempts = 2; // Try 2 times in total
    let currentValue = '';

    while (attempts < maxAttempts) {
        attempts++;
        logger.debug(`Attempt ${attempts}/${maxAttempts} to set value and verify ${fieldName}...`);
        try {
            // 2. Focus and Set Value using evaluate (simulates "paste")
            await elementHandle.focus();
            await delay(150);
            logger.debug(`Setting value "${valueToSet}" for ${fieldName} using evaluate...`);
            // Implicitly clear by assigning .value
            await elementHandle.evaluate((el, value) => {
                el.value = value; // Set value directly
                // Trigger important events for the page to react
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur')); // Simulate loss of focus
            }, valueToSet);
            logger.debug(`Finished setting value attempt ${attempts} for ${fieldName}.`);
            await delay(800); // LONGER pause after setting, before verification

            // 3. Verify the final value
            currentValue = await elementHandle.evaluate(el => el.value);
            if (currentValue === valueToSet) {
                logger.info(`Field ${fieldName} SET and verified successfully on attempt ${attempts}.`);
                return; // Success! Exit the function.
            }

            // If verification fails
            logger.warn(`Verification failed for ${fieldName} on attempt ${attempts}. Expected: "${valueToSet}", Got: "${currentValue}"`);
            if (attempts < maxAttempts) {
                logger.info("Retrying...");
                await delay(1200); // Longer wait before retrying
            }

        } catch (error) {
            logger.error(`Error during set/verify attempt ${attempts} for ${fieldName}: ${error.message}`);
             if (attempts >= maxAttempts) {
                 logger.error(`Throwing error after ${attempts} failed attempts for ${fieldName}.`);
                 // *** Throw error to stop signIn/signUp execution ***
                 throw error; // Rethrow if it's the last attempt
             }
             await delay(1200); // Wait before retrying after an error
        }
    } // End while

    // If the loop ends without success
    logger.error(`VERIFICATION FAILED for ${fieldName} after ${maxAttempts} attempts. Expected: "${valueToSet}", Got: "${currentValue}"`);
    // *** Throw error to stop signIn/signUp execution ***
    throw new Error(`Verification failed for field: ${fieldName} after ${maxAttempts} attempts. Expected: "${valueToSet}", Got: "${currentValue}"`);
}


/**
 * Performs the registration process following the EXACT v11 flow.
 * (Scroll down, wait 12s, scroll up, fill/verify fields with scroll, click).
 * @returns {Promise<boolean>}
 */
async function signUp() {
    logger.info('Starting registration process (Exact Flow v11)...');
    const page = getPage();
    if (!page) { logger.error('SignUp: Page not available.'); return false; }
    const config = getConfig();
    const longTimeout = 60 * 1000;

    try {
        // 1. Navigate and wait for initial load
        await navigateTo(SIGNUP_URL);
        logger.info(`Navigation to ${SIGNUP_URL} completed.`);
        await delay(2000);

        // 2. Verify URL and possible initial block
        let currentUrl = page.url();
        logger.info(`Verifying current URL: ${currentUrl}`);
        if (!currentUrl.includes('signup.php')) {
            logger.warn(`We're not on signup.php (URL: ${currentUrl}). Assuming initial CAPTCHA block. Waiting for redirect...`);
            try {
                // *** Use waitForNavigation to wait for redirection ***
                await page.waitForNavigation({ waitUntil: 'load', timeout: longTimeout });
                currentUrl = page.url();
                logger.info(`URL after waiting for possible block: ${currentUrl}`);
            } catch (waitError) { throw new Error(`Timeout waiting for redirect to signup.php: ${waitError.message}`); }
        }
        if (!currentUrl.includes('signup.php')) { throw new Error(`Failed to reach signup.php. Final URL: ${currentUrl}`); }
        logger.info('Confirmed: We are on the signup page.');

        // 3. Initial Scroll TO #referrer
        logger.info('Step 1: Initial scroll to the Referrer/Captcha area...');
        await waitAndEnsureVisible(page, SELECTORS.referrerInput, true, longTimeout); // needsScroll = true

        // 4. Explicit 12-second Wait
        logger.info('Step 2: Waiting 12 seconds (for possible automatic CAPTCHA resolution in the form)...');
        await delay(12000);

        // 5. Scroll to Captcha area (without explicit verification)
        logger.info('Step 3: Scrolling to captcha area to ensure it was visible...');
        try {
            await waitAndEnsureVisible(page, SELECTORS.captchaDiv, true, 15000); // needsScroll = true
        } catch (scrollError) {
            logger.warn(`Couldn't scroll to captcha div (${SELECTORS.captchaDiv}), continuing... Error: ${scrollError.message}`);
        }
        logger.info('Assuming the CAPTCHA was resolved. Proceeding to fill in the form.');
        await delay(1000);

        // --- 6. Fill in the form ---
        logger.info('Step 4: Filling out registration form...');

        // *** USE CORRECT FUNCTION NAME AND needsScroll = true ***
        // 6.1 Username
        await waitScrollSetValueAndVerifyStrict(page, SELECTORS.usernameInput, config.tronpickUsername, 'Username', true, longTimeout);
        await delay(600);

        // 6.2 Email
        await waitScrollSetValueAndVerifyStrict(page, SELECTORS.emailInput, config.emailUser, 'Email', true, longTimeout);
        await delay(600);

        // 6.3 Password
        await waitScrollSetValueAndVerifyStrict(page, SELECTORS.passwordInput, config.tronpickPassword, 'Password', true, longTimeout);
        await delay(600);

        // 6.4 Confirm Password
        await waitScrollSetValueAndVerifyStrict(page, SELECTORS.confirmPasswordInput, config.tronpickPassword, 'Confirm Password', true, longTimeout);
        await delay(600);

        // 6.5 Referrer (Optional)
        await waitScrollSetValueAndVerifyStrict(page, SELECTORS.referrerInput, config.referrerCode, 'Referrer', true, longTimeout);
        await delay(600);

        // --- 7. CLICK REGISTER ---
        logger.info(`Step 5: Waiting and scrolling to ${SELECTORS.signupButton}...`);
        const signupButtonHandle = await waitAndEnsureVisible(page, SELECTORS.signupButton, true, longTimeout); // needsScroll = true
        logger.info('Attempting to click the registration button...');
        await signupButtonHandle.click({ delay: 150 });
        logger.info(`Click executed on ${SELECTORS.signupButton}.`);

        // --- 8. WAIT FOR RESULT (Redirect or Visible Error) ---
        logger.info('Registration submitted. Waiting for result (redirect or error message)...');
        const navigationTimeout = 45000;
        // *** CORRECTION: Use page.waitForNavigation to wait for redirect ***
        const navigationPromise = page.waitForNavigation({
            waitUntil: 'load', // Wait for the new page to load
            timeout: navigationTimeout
         }).then(() => 'navigation') // Return 'navigation' if successful
           .catch(e => {
                logger.debug(`Timeout/Error waiting for post-signup navigation: ${e.message}`);
                return null; // Return null in case of error/timeout
            });

        const errorPromise = page.waitForSelector(
            SELECTORS.errorMessageContainer,
            { visible: true, timeout: navigationTimeout }
        ).then(handle => 'error') // Return 'error' if the selector appears
         .catch(e => {
             logger.debug(`Timeout/Error waiting for post-signup error message (${SELECTORS.errorMessageContainer}): ${e.message}`);
             return null; // Return null if it doesn't appear
         });

        logger.debug('Waiting for Promise.race between navigation and error...');
        const raceWinner = await Promise.race([navigationPromise, errorPromise]);
        await delay(1000); // Pause to stabilize
        const finalUrlAfterClick = page.url();
        logger.debug(`Promise.race result: ${raceWinner}. URL after click: ${finalUrlAfterClick}`);

        // Verify the result
        if (raceWinner === 'navigation' && (finalUrlAfterClick.includes('/faucet.php') || finalUrlAfterClick.includes('/settings.php'))) {
            logger.info('Redirect detected. Registration completed successfully!');
            return true; // Success
        } else {
            // If there was no navigation or the error promise won
            let errorMessage = 'No expected redirect or an error appeared.';
            try {
                 // Try to get the error message if that promise won or if there was no navigation
                 if (raceWinner === 'error' || !finalUrlAfterClick.includes('/faucet.php') && !finalUrlAfterClick.includes('/settings.php')) {
                     const errorElement = await page.$(SELECTORS.errorMessageContainer);
                     if (errorElement) {
                         errorMessage = await errorElement.evaluate(el => el.textContent);
                         logger.error(`Registration failed. Error message detected: ${errorMessage.trim()}`);
                     } else {
                         logger.error(`Registration failed. ${errorMessage} Final URL: ${finalUrlAfterClick}`);
                     }
                 } else {
                      // If raceWinner is 'navigation' but the URL is not what we expect
                      logger.error(`Registration failed. Unexpected redirect to: ${finalUrlAfterClick}`);
                      errorMessage = `Unexpected redirect to: ${finalUrlAfterClick}`;
                 }
            } catch (e) {
                 logger.error(`Registration failed and error getting message: ${e.message}`);
                 errorMessage = e.message;
             }
             // Throw error so the Orchestrator knows it failed
             throw new Error(`Registration failed: ${errorMessage.trim()}`);
        }

    } catch (error) {
        logger.error(`Error during registration process: ${error.message}`);
        // Log stack trace only for unexpected errors
        if (!error.message.startsWith('Registration failed') && !error.message.startsWith('Critical failure') && !error.message.startsWith('Verification failed')) {
            logger.error(error.stack);
        }
        // Take Screenshot
        if (page && !error.message.includes('Target closed')) {
           try {
               await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
               const screenshotPath = path.join(SCREENSHOTS_DIR, `error_signup_${Date.now()}.png`);
               await page.screenshot({ path: screenshotPath, fullPage: true });
               logger.info(`Screenshot saved to: ${screenshotPath}`);
            } catch (screenshotError) { logger.error(`Error taking/saving screenshot: ${screenshotError.message}`); }
        }
        return false; // Indicate failure to the Orchestrator
    }
} // End signUp

/**
 * Performs the login process with multiple retries.
 * @returns {Promise<boolean>} True if login is successful, false otherwise.
 */
async function signIn() {
    logger.info('Starting login process with retry mechanism...');
    const page = getPage();
    if (!page) { logger.error('SignIn: Page not available.'); return false; }
    const config = getConfig();
    const longTimeout = 60 * 1000;
    
    // New retry mechanism variables
    const MAX_LOGIN_ATTEMPTS = 3;
    let loginAttempts = 0;
    let loginSuccess = false;
    
    while (loginAttempts < MAX_LOGIN_ATTEMPTS && !loginSuccess) {
        loginAttempts++;
        logger.info(`Login attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS}...`);
        
        try {
            // 1. Navigate (or confirm being on) Login Page
            await delay(500); // Small initial pause
            let currentUrl = page.url();
            logger.info(`Verifying current URL at start of signIn: ${currentUrl}`);
            if (!currentUrl.includes('login.php')) {
                 // If we're not on login.php, navigate there explicitly
                 await navigateTo(LOGIN_URL);
                 logger.info(`Forced navigation to ${LOGIN_URL} completed.`);
                 await delay(1500);
                 currentUrl = page.url(); // Re-verify URL
            }

            // Handle potential initial block that redirects to another site AFTER going to login
            if (!currentUrl.includes('login.php')) {
                 logger.warn(`We're not on login.php (URL: ${currentUrl}). Waiting for possible redirect or confirming session...`);
                 try {
                     // Wait to reach login or faucet
                     // *** CORRECTION: Use waitForNavigation to wait for redirect ***
                     await page.waitForNavigation({ waitUntil: 'load', timeout: longTimeout });
                     currentUrl = page.url();
                     logger.info(`URL after waiting: ${currentUrl}`);
                     if (currentUrl.includes('/faucet.php')) {
                         logger.info("It appears there was already an active session (detected in signIn).");
                         return true; // Success (already logged in)
                     } else if (!currentUrl.includes('login.php')) {
                         // If after waiting we're still not on login, fail
                         throw new Error(`Unexpected URL after waiting: ${currentUrl}`);
                     }
                 } catch (waitError) {
                     // If waitForNavigation fails (e.g., timeout), throw error
                     throw new Error(`Timeout or error waiting to reach login/faucet: ${waitError.message}`);
                 }
            }
            logger.info('Confirmed: We are on the login page.');

            // 2. Fixed Wait for CAPTCHA (increased to 20 seconds for more reliability)
            logger.info(`Step 1: Waiting 20 seconds for CAPTCHA resolution (Attempt ${loginAttempts})...`);
            await delay(20000); // Increased wait time for CAPTCHA resolution

            // 3. Fill in form (NO Scroll, with strict verification)
            logger.info('Step 2: Filling in login form...');

            // 3.1 Email (needsScroll = false)
            await waitScrollSetValueAndVerifyStrict(page, SELECTORS.emailInput, config.emailUser, 'Login Email', false, longTimeout);
            await delay(400);

            // 3.2 Password (needsScroll = false)
            await waitScrollSetValueAndVerifyStrict(page, SELECTORS.passwordInput, config.tronpickPassword, 'Login Password', false, longTimeout);
            await delay(400);

            // 4. *** REMOVED: Explicit CAPTCHA verification ***
            logger.info('Step 3: Assuming CAPTCHA is resolved. Proceeding to click.');
            await delay(1000);

            // 5. Click the Login button (CORRECTED METHOD)
            logger.info(`Step 4: Waiting for ${SELECTORS.loginButton}...`);
            // Wait for visibility but DO NOT scroll
            await page.waitForSelector(SELECTORS.loginButton, { state: 'visible', timeout: longTimeout });
            
            // ***CORRECTED CODE: Use evaluate to click with JavaScript instead of mouse simulation***
            logger.info('Attempting to click login button using JavaScript...');
            
            // Retry implementation for click
            let clickSuccess = false;
            const maxClickAttempts = 3;
            let clickAttempts = 0;
            
            while (!clickSuccess && clickAttempts < maxClickAttempts) {
                clickAttempts++;
                try {
                    logger.info(`Attempt ${clickAttempts}/${maxClickAttempts} to click login button...`);
                    
                    // Use evaluate to run the click directly on the page
                    await page.evaluate((selector) => {
                        const button = document.querySelector(selector);
                        if (button) {
                            button.click();
                        } else {
                            console.error('Button not found in page context');
                        }
                    }, SELECTORS.loginButton);
                    
                    // If no error is thrown, assume success
                    clickSuccess = true;
                    logger.info(`Click successfully executed on attempt ${clickAttempts} using JavaScript.`);
                } catch (clickError) {
                    logger.warn(`Error on click attempt ${clickAttempts}: ${clickError.message}`);
                    
                    if (clickAttempts < maxClickAttempts) {
                        logger.info(`Waiting before retry...`);
                        await delay(1000); // Wait before retrying
                    }
                }
            }
            
            if (!clickSuccess) {
                throw new Error(`Could not click login button after ${maxClickAttempts} attempts.`);
            }

            // 6. WAIT FOR RESULT (Redirect or Visible Error - 20 seconds) - Increased from 10 to 20 seconds
            logger.info('Login submitted. Waiting for result (max 20s)...');
            const navigationTimeout = 20000; // <-- Increased timeout to 20 seconds
            // *** CORRECTION: Use page.waitForNavigation to wait for redirect ***
            const navigationPromise = page.waitForNavigation({
                waitUntil: 'load', // Wait for the new page to load
                timeout: navigationTimeout
             }).then(() => 'navigation') // Return 'navigation' if successful
               .catch(e => {
                    logger.debug(`Timeout/Error waiting for post-login navigation: ${e.message}`);
                    return null; // Return null in case of error/timeout
                });

            const errorPromise = page.waitForSelector(
                SELECTORS.errorMessageContainer,
                { visible: true, timeout: navigationTimeout }
            ).then(handle => 'error') // Return 'error' if the selector appears
             .catch(e => {
                 logger.debug(`Timeout/Error waiting for post-login error message (${SELECTORS.errorMessageContainer}): ${e.message}`);
                 return null; // Return null if it doesn't appear
             });

            logger.debug('Waiting for Promise.race between navigation and error post-login...');
            const raceWinner = await Promise.race([navigationPromise, errorPromise]);
            await delay(1000); // Pause to let URL update if there was navigation
            const finalUrlAfterClick = page.url();
            logger.debug(`Promise.race result: ${raceWinner}. URL after Promise.race post-login: ${finalUrlAfterClick}`);

            // Verify the result - FIXED LOGIC
            if ((raceWinner === 'navigation' && finalUrlAfterClick.includes('/faucet.php')) || 
                finalUrlAfterClick.includes('/faucet.php')) {
                // Check for success with EITHER condition: navigation won AND at faucet.php, OR
                // just being at faucet.php regardless of which promise won
                logger.info('Redirect to Faucet detected or already on Faucet page. Login successful!');
                loginSuccess = true; // Mark as successful for the while loop
                return true; // Success
            } else {
                // If no navigation or the error promise won
                let errorMessage = `Login attempt ${loginAttempts} failed: No redirect to /faucet.php or error appeared in ${navigationTimeout/1000}s.`;
                try {
                     // Try to get the error handle if that promise won
                     const errorElement = (raceWinner === 'error') ? await page.$(SELECTORS.errorMessageContainer) : null;

                     if (errorElement) {
                         errorMessage = await errorElement.evaluate(el => el.textContent); // Use evaluate to get text
                         logger.error(`Login attempt ${loginAttempts} failed. Error message detected: ${errorMessage.trim()}`);
                     } else {
                         // If there was no redirect AND no error message was found
                         logger.error(`${errorMessage} Final URL: ${finalUrlAfterClick}`);
                     }
                } catch (e) {
                    // Error trying to get the error message
                     logger.error(`Login attempt ${loginAttempts} failed and error getting message: ${e.message}`);
                     errorMessage = e.message; // Use the error message from the get if it fails
                 }
                 logger.warn(`Login attempt ${loginAttempts} failed (final message: ${errorMessage.trim()})`);
                 
                 // If we have more attempts to go, refresh the page and try again
                 if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
                     logger.info(`Refreshing page and waiting 5 seconds before attempt ${loginAttempts + 1}...`);
                     await navigateTo(LOGIN_URL); // Navigate again to ensure fresh page
                     await delay(5000); // Wait 5 seconds between attempts
                 } else {
                     logger.error(`All ${MAX_LOGIN_ATTEMPTS} login attempts failed. Returning false to trigger registration.`);
                     return false; // Return false after all attempts fail
                 }
            }

        } catch (error) {
            // Catch errors thrown by helpers (e.g., failed verification) or waits
            logger.error(`Technical error during login attempt ${loginAttempts}: ${error.message}`);
            // Log stack trace only for unexpected errors
            if (!error.message.startsWith('Login failed') && !error.message.startsWith('Critical failure') && !error.message.startsWith('Verification failed')) {
                logger.error(error.stack);
            }
            // Take Screenshot
            if (page && !error.message.includes('Target closed')) {
               try {
                   await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
                   const screenshotPath = path.join(SCREENSHOTS_DIR, `error_login_attempt${loginAttempts}_${Date.now()}.png`);
                   await page.screenshot({ path: screenshotPath, fullPage: true });
                   logger.info(`Screenshot saved to: ${screenshotPath}`);
                } catch (screenshotError) { logger.error(`Error taking/saving screenshot: ${screenshotError.message}`); }
            }
            
            // If we have more attempts to go, wait and try again
            if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
                logger.info(`Waiting 10 seconds before attempt ${loginAttempts + 1} due to error...`);
                await delay(10000); // Longer wait if there was an error
                // Try to refresh the page
                try {
                    await navigateTo(LOGIN_URL);
                } catch (navError) {
                    logger.warn(`Failed to refresh page: ${navError.message}`);
                }
            } else {
                logger.error(`All ${MAX_LOGIN_ATTEMPTS} login attempts failed with technical errors.`);
                // *** IMPORTANT: Throw error so Orchestrator knows it was a technical failure ***
                throw error; // Rethrow the error so Orchestrator goes to ERROR
            }
        }
    } // End while loop for retries
    
    // If we get here, all attempts failed but no exception was thrown
    return false;
} // End signIn


// Export both functions
export { signUp, signIn };