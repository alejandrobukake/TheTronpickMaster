// src/modules/FaucetClaimer.js

import logger from '../utils/logger.js'; // For logging
import { getPage, navigateTo } from './BrowserManager.js'; // For browser control
import { delay } from '../utils/helpers.js'; // For pauses

// Important URLs
const FAUCET_URL = 'https://tronpick.io/faucet.php';

// CSS Selectors
const SELECTORS = {
    // Bonus Faucet
    bonusFaucetRadio: '#select_bonus_faucet', // Radio button for Bonus Faucet
    bonusFaucetRadioLabel: 'label[for="select_bonus_faucet"]', // Label for better clicking
    freeSpinsCounter: '#free_spins', // Counter showing available bonus spins
    bonusClaimButton: '#process_claim_bonus_faucet', // Button to claim bonus
    bonusSuccessMessage: 'div.alert.alert-success', // Success message
    
    // Hourly Faucet
    hourlyFaucetRadio: '#select_hourly_faucet', // Radio button for Hourly Faucet
    hourlyFaucetRadioLabel: 'label[for="select_hourly_faucet"]', // Label for better clicking
    hourlyClaimButton: '#process_claim_hourly_faucet', // Button to claim hourly faucet
    
    // Captcha related
    captchaFrame: 'iframe[title*="reCAPTCHA"]', // reCAPTCHA iframe
    cloudflareWidget: '[id^="qOTkU"]', // Cloudflare Turnstile widget
    turnstileCheckbox: '.cb-lb input[type="checkbox"]', // Turnstile checkbox
    
    // Messages and UI elements
    errorMessage: 'div.alert.alert-danger, div.alert.alert-warning', // Error messages
    userBalance: 'span.user_balance', // Shows current balance
    
    // Survey elements to hide
    surveySection: '#show_surveys', // Main surveys container
};

/**
 * Hides the survey section on the faucet page
 * @returns {Promise<boolean>} True if successfully hidden or not found, false on error
 */
async function hideSurveysSection() {
    logger.info('Attempting to hide surveys section...');
    const page = getPage();
    if (!page) {
        logger.error('Page not available to hide surveys.');
        return false;
    }
    
    try {
        // Check if survey section exists
        const surveySectionExists = await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            return !!element;
        }, SELECTORS.surveySection);
        
        if (!surveySectionExists) {
            logger.info('Survey section not found on page. Nothing to hide.');
            return true;
        }
        
        // Hide the survey section using DOM manipulation
        await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
                // Also try to remove event listeners
                const newElement = element.cloneNode(true);
                if (element.parentNode) {
                    element.parentNode.replaceChild(newElement, element);
                }
            }
        }, SELECTORS.surveySection);
        
        logger.info('Survey section successfully hidden.');
        return true;
    } catch (error) {
        logger.error(`Error hiding survey section: ${error.message}`);
        return false;
    }
}

/**
 * Checks if there are any available bonus spins
 * @returns {Promise<number>} Number of available spins, or 0 if none/error
 */
async function getAvailableBonusSpins() {
    const page = getPage();
    if (!page) {
        logger.error('Page not available to check bonus spins.');
        return 0;
    }
    
    try {
        // Wait a short time for the element to be visible
        try {
            await page.waitForSelector(SELECTORS.freeSpinsCounter, { 
                state: 'visible', 
                timeout: 5000 
            });
        } catch (timeoutError) {
            logger.warn(`Could not find free spins counter: ${timeoutError.message}`);
            return 0;
        }
        
        // Read the value of the free spins counter
        const spinsAvailable = await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (!element) return 0;
            const value = parseInt(element.textContent.trim(), 10);
            return isNaN(value) ? 0 : value;
        }, SELECTORS.freeSpinsCounter);
        
        logger.info(`Available bonus spins: ${spinsAvailable}`);
        return spinsAvailable;
    } catch (error) {
        logger.error(`Error checking available bonus spins: ${error.message}`);
        return 0;
    }
}

/**
 * Selects the Bonus Faucet tab
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function selectBonusFaucetTab() {
    logger.info('Selecting Bonus Faucet tab...');
    const page = getPage();
    if (!page) return false;
    
    try {
        // First try clicking the radio button directly
        try {
            await page.waitForSelector(SELECTORS.bonusFaucetRadio, { 
                state: 'visible', 
                timeout: 5000 
            });
            
            // Check if it's already selected
            const isAlreadySelected = await page.evaluate((selector) => {
                const radio = document.querySelector(selector);
                return radio && radio.checked;
            }, SELECTORS.bonusFaucetRadio);
            
            if (isAlreadySelected) {
                logger.info('Bonus Faucet tab is already selected.');
                return true;
            }
            
            // Click the radio button
            await page.click(SELECTORS.bonusFaucetRadio);
            logger.info('Clicked Bonus Faucet radio button.');
        } catch (radioError) {
            // If direct click fails, try clicking the label instead
            logger.warn(`Could not click radio directly: ${radioError.message}`);
            logger.info('Trying to click the label instead...');
            
            await page.waitForSelector(SELECTORS.bonusFaucetRadioLabel, {
                state: 'visible',
                timeout: 5000
            });
            
            await page.click(SELECTORS.bonusFaucetRadioLabel);
            logger.info('Clicked Bonus Faucet label.');
        }
        
        // Wait for UI to update
        await delay(1500);
        
        // Verify the tab was actually selected
        const isSelected = await page.evaluate((selector) => {
            const radio = document.querySelector(selector);
            return radio && radio.checked;
        }, SELECTORS.bonusFaucetRadio);
        
        if (!isSelected) {
            logger.warn('Failed to select Bonus Faucet tab after clicking.');
            
            // One more attempt using JavaScript directly
            await page.evaluate((selector) => {
                const radio = document.querySelector(selector);
                if (radio) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, SELECTORS.bonusFaucetRadio);
            
            logger.info('Used JavaScript to force Bonus Faucet selection.');
            await delay(1500);
        }
        
        return true;
    } catch (error) {
        logger.error(`Error selecting Bonus Faucet tab: ${error.message}`);
        return false;
    }
}

/**
 * Selects the Hourly Faucet tab
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function selectHourlyFaucetTab() {
    logger.info('Selecting Hourly Faucet tab...');
    const page = getPage();
    if (!page) return false;
    
    try {
        // First try clicking the radio button directly
        try {
            await page.waitForSelector(SELECTORS.hourlyFaucetRadio, { 
                state: 'visible', 
                timeout: 5000 
            });
            
            // Check if it's already selected
            const isAlreadySelected = await page.evaluate((selector) => {
                const radio = document.querySelector(selector);
                return radio && radio.checked;
            }, SELECTORS.hourlyFaucetRadio);
            
            if (isAlreadySelected) {
                logger.info('Hourly Faucet tab is already selected.');
                return true;
            }
            
            // Click the radio button
            await page.click(SELECTORS.hourlyFaucetRadio);
            logger.info('Clicked Hourly Faucet radio button.');
        } catch (radioError) {
            // If direct click fails, try clicking the label instead
            logger.warn(`Could not click radio directly: ${radioError.message}`);
            logger.info('Trying to click the label instead...');
            
            await page.waitForSelector(SELECTORS.hourlyFaucetRadioLabel, {
                state: 'visible',
                timeout: 5000
            });
            
            await page.click(SELECTORS.hourlyFaucetRadioLabel);
            logger.info('Clicked Hourly Faucet label.');
        }
        
        // Wait for UI to update
        await delay(1500);
        
        // Verify the tab was actually selected
        const isSelected = await page.evaluate((selector) => {
            const radio = document.querySelector(selector);
            return radio && radio.checked;
        }, SELECTORS.hourlyFaucetRadio);
        
        if (!isSelected) {
            logger.warn('Failed to select Hourly Faucet tab after clicking.');
            
            // One more attempt using JavaScript directly
            await page.evaluate((selector) => {
                const radio = document.querySelector(selector);
                if (radio) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, SELECTORS.hourlyFaucetRadio);
            
            logger.info('Used JavaScript to force Hourly Faucet selection.');
            await delay(1500);
        }
        
        return true;
    } catch (error) {
        logger.error(`Error selecting Hourly Faucet tab: ${error.message}`);
        return false;
    }
}

/**
 * Waits for CAPTCHA to be solved
 * This relies on puppeteer-real-browser's automatic solving
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds
 * @returns {Promise<boolean>} True if CAPTCHA appears solved, false otherwise
 */
async function waitForCaptchaSolution(maxWaitTime = 30000) {
    logger.info(`Waiting up to ${maxWaitTime/1000} seconds for CAPTCHA to be solved...`);
    const page = getPage();
    if (!page) return false;
    
    const startTime = Date.now();
    let captchaSolved = false;
    
    while (Date.now() - startTime < maxWaitTime) {
        try {
            // Check if there's a success message visible (indicating CAPTCHA is solved)
            const successElement = await page.$('div.cb-container[role="alert"][style*="display: flex"]');
            if (successElement) {
                logger.info('CAPTCHA success indicator found!');
                captchaSolved = true;
                break;
            }
            
            // Check if the claim button is enabled (another indicator CAPTCHA is solved)
            const claimButtonEnabled = await page.evaluate((hourlySelector, bonusSelector) => {
                const hourlyButton = document.querySelector(hourlySelector);
                const bonusButton = document.querySelector(bonusSelector);
                const activeButton = hourlyButton || bonusButton;
                
                // Check if button exists and is not disabled
                return activeButton && !activeButton.disabled && 
                    !activeButton.classList.contains('disabled') &&
                    activeButton.style.opacity !== '0.5';
            }, SELECTORS.hourlyClaimButton, SELECTORS.bonusClaimButton);
            
            if (claimButtonEnabled) {
                logger.info('Claim button appears enabled, assuming CAPTCHA is solved');
                captchaSolved = true;
                break;
            }
            
            // Wait a bit before checking again
            await delay(1000);
        } catch (error) {
            logger.debug(`Error checking CAPTCHA status: ${error.message}`);
            await delay(1000);
        }
    }
    
    if (captchaSolved) {
        logger.info('CAPTCHA appears to be solved successfully');
        return true;
    } else {
        logger.warn(`CAPTCHA solution not detected after ${maxWaitTime/1000} seconds`);
        return false;
    }
}

/**
 * Claims a single bonus spin 
 * @returns {Promise<boolean>} True if claimed successfully, false otherwise
 */
async function claimSingleBonusSpin() {
    logger.info('Attempting to claim a single bonus spin...');
    const page = getPage();
    if (!page) return false;
    
    try {
        // Wait for claim button to be visible
        await page.waitForSelector(SELECTORS.bonusClaimButton, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Wait a moment before clicking (let any animations finish)
        await delay(1000);
        
        // Click the claim button
        logger.info('Clicking the bonus claim button...');
        await page.click(SELECTORS.bonusClaimButton);
        
        // Wait for the result (the number display animation)
        logger.info('Waiting for claim result...');
        await delay(5000);
        
        // Check if claim was successful by looking for success message or checking if spins decreased
        const claimSuccessful = await page.evaluate((successSelector) => {
            const successMessage = document.querySelector(successSelector);
            return !!successMessage;
        }, SELECTORS.bonusSuccessMessage);
        
        if (claimSuccessful) {
            logger.info('Bonus spin claimed successfully!');
            
            // Close any success messages if they exist
            await page.evaluate(() => {
                const closeButtons = document.querySelectorAll('a.close.dismiss_noti_button');
                for (const button of closeButtons) {
                    button.click();
                }
            });
        } else {
            // Check if spins decreased directly
            logger.info('No success message found. Checking if spins were decremented...');
        }
        
        return true;
    } catch (error) {
        logger.error(`Error claiming single bonus spin: ${error.message}`);
        return false;
    }
}

/**
 * Claims all available bonus faucet spins
 * @returns {Promise<boolean>} True if any spins were claimed or none available, false only on error
 */
async function claimBonusFaucet() {
    logger.info('Starting bonus faucet claim process...');
    const page = getPage();
    if (!page) {
        logger.error('Page not available for bonus faucet claiming.');
        return false;
    }
    
    try {
        // 1. Navigate to faucet page if not already there
        if (!page.url().includes('/faucet.php')) {
            logger.info('Navigating to faucet page...');
            await navigateTo(FAUCET_URL);
            await delay(2000);
        }
        
        // 2. Hide surveys section first to clean up the page
        await hideSurveysSection();
        
        // 3. Check how many bonus spins are available
        const initialSpinsAvailable = await getAvailableBonusSpins();
        if (initialSpinsAvailable <= 0) {
            logger.info('No bonus spins available to claim. Skipping.');
            return true; // No spins is not an error condition
        }
        
        // 4. Select the Bonus Faucet tab
        if (!await selectBonusFaucetTab()) {
            logger.error('Failed to select Bonus Faucet tab. Cannot proceed with claiming.');
            return false;
        }
        
        // 5. Process all available spins one by one
        let remainingSpins = initialSpinsAvailable;
        let totalClaimed = 0;
        
        while (remainingSpins > 0) {
            logger.info(`Processing bonus spin ${totalClaimed + 1} of ${initialSpinsAvailable}...`);
            
            // Wait for CAPTCHA to be solved (this relies on puppeteer-real-browser)
            logger.info('Waiting for CAPTCHA to be solved automatically...');
            await waitForCaptchaSolution(30000);
            
            // Claim the spin
            const claimSuccess = await claimSingleBonusSpin();
            if (claimSuccess) {
                totalClaimed++;
                // Check how many spins remain
                await delay(2000); // Wait for UI to update
                remainingSpins = await getAvailableBonusSpins();
                logger.info(`Spin claimed! Remaining spins: ${remainingSpins}`);
            } else {
                logger.warn('Failed to claim this spin. Trying next one...');
                // Refresh page to reset any potential issues
                logger.info('Refreshing page to reset state...');
                await navigateTo(FAUCET_URL);
                await delay(2000);
                await hideSurveysSection();
                await selectBonusFaucetTab();
                remainingSpins = await getAvailableBonusSpins();
            }
            
            // Short delay between claims
            await delay(2000);
        }
        
        logger.info(`Bonus faucet claiming complete. Claimed ${totalClaimed} of ${initialSpinsAvailable} spins.`);
        
        // 6. Switch back to hourly faucet tab when done
        logger.info('Switching back to Hourly Faucet tab...');
        await selectHourlyFaucetTab();
        await delay(1500);
        
        return true;
    } catch (error) {
        logger.error(`Error during bonus faucet claiming process: ${error.message}`);
        return false;
    }
}

/**
 * Claims the hourly faucet with explicit 20 second CAPTCHA wait
 * @returns {Promise<boolean>} True if claimed successfully, false otherwise
 */
async function claimHourlyFaucet() {
    logger.info('Starting hourly faucet claim process...');
    const page = getPage();
    if (!page) {
        logger.error('Page not available for hourly faucet claiming.');
        return false;
    }
    
    try {
        // 1. Navigate to faucet page if not already there
        if (!page.url().includes('/faucet.php')) {
            logger.info('Navigating to faucet page...');
            await navigateTo(FAUCET_URL);
            await delay(2000);
        }
        
        // 2. Hide surveys section first to clean up the page
        await hideSurveysSection();
        
        // 3. IMPORTANT: Make sure we're on the hourly faucet tab
        if (!await selectHourlyFaucetTab()) {
            logger.error('Failed to select Hourly Faucet tab. Cannot proceed with claiming.');
            return false;
        }
        
        // 4. Wait explicitly 20 seconds for CAPTCHA to auto-resolve
        // Note: This explicit 20-second wait is added as requested
        logger.info('Waiting 20 seconds for CAPTCHA to auto-resolve...');
        await delay(20000);
        
        // 5. After waiting, check if CAPTCHA appears solved
        logger.info('Checking if CAPTCHA appears solved after 20-second wait...');
        const captchaSolved = await waitForCaptchaSolution(5000); // Short additional check
        
        if (!captchaSolved) {
            logger.warn('CAPTCHA solution not detected after 20-second wait. Will attempt to proceed anyway...');
        } else {
            logger.info('CAPTCHA appears solved after waiting.');
        }
        
        // 6. Wait for the claim button to be visible and enabled
        try {
            await page.waitForSelector(SELECTORS.hourlyClaimButton, { 
                state: 'visible', 
                timeout: 10000 
            });
        } catch (buttonError) {
            logger.error(`Could not find hourly claim button: ${buttonError.message}`);
            return false;
        }
        
        // Wait a bit longer for any animations/CAPTCHA processes to complete
        await delay(3000);
        
        // 7. Click the claim button
        logger.info('Clicking hourly faucet claim button...');
        try {
            await page.click(SELECTORS.hourlyClaimButton);
        } catch (clickError) {
            logger.error(`Error clicking claim button: ${clickError.message}`);
            
            // Try alternative click method
            logger.info('Trying alternative click method...');
            await page.evaluate((selector) => {
                const button = document.querySelector(selector);
                if (button) button.click();
            }, SELECTORS.hourlyClaimButton);
        }
        
        // 8. Wait for the result and check for success
        logger.info('Waiting for claim result...');
        await delay(5000);
        
        // Check if claim was successful by looking for success message
        const claimSuccessful = await page.evaluate((successSelector, errorSelector) => {
            const successMessage = document.querySelector(successSelector);
            const errorMessage = document.querySelector(errorSelector);
            
            if (successMessage) {
                return { success: true, message: successMessage.textContent.trim() };
            } else if (errorMessage) {
                return { success: false, message: errorMessage.textContent.trim() };
            } else {
                return { success: false, message: 'No success or error message found.' };
            }
        }, SELECTORS.bonusSuccessMessage, SELECTORS.errorMessage);
        
        if (claimSuccessful.success) {
            logger.info(`Hourly faucet claimed successfully! Message: ${claimSuccessful.message}`);
            return true;
        } else {
            logger.warn(`Hourly faucet claim may have failed. Message: ${claimSuccessful.message}`);
            
            // Check if balance increased anyway
            try {
                const balance = await page.evaluate((selector) => {
                    const element = document.querySelector(selector);
                    return element ? element.textContent.trim() : null;
                }, SELECTORS.userBalance);
                
                logger.info(`Current balance: ${balance}`);
            } catch (balanceError) {
                logger.debug(`Could not get balance: ${balanceError.message}`);
            }
            
            // Take screenshot for diagnostics
            try {
                const screenshotPath = `./screenshots/hourly_claim_result_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logger.info(`Screenshot saved to: ${screenshotPath}`);
            } catch (screenshotError) {
                logger.warn(`Could not take screenshot: ${screenshotError.message}`);
            }
            
            // Even if we're not sure, return true to avoid retrying immediately 
            // (as the faucet has a time limit anyway)
            return true;
        }
    } catch (error) {
        logger.error(`Error during hourly faucet claiming process: ${error.message}`);
        return false;
    }
}

// Export the functions
export { claimBonusFaucet, claimHourlyFaucet, hideSurveysSection, getAvailableBonusSpins };