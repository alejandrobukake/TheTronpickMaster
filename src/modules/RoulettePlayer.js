// src/modules/RoulettePlayer.js
//
// This module implements the Martingale-based roulette strategy
// for the TronPick platform. It adapts the logic from the original Python script
// to JavaScript and integrates with the project's orchestration system.

import crypto from 'crypto'; // For generating random seed
import fs from 'fs/promises'; // For creating directories if needed
import path from 'path';     // For file paths
import logger from '../utils/logger.js';
import { getPage, navigateTo } from './BrowserManager.js';
import { delay } from '../utils/helpers.js'; // For pauses

const ROULETTE_URL = 'https://tronpick.io/roulette.php';
const SCREENSHOTS_DIR = './screenshots';

// CSS Selectors - Based on TronPick's current structure
const SELECTORS = {
    // Betting interface
    betAmountInput: '#bet_amount',
    clearButton: '#clear_all_bet_chips',
    spinButton: '#bet_btn',
    // Chips - Object for iteration through them
    chips: {
        100: "div.chip[data-coin='100']", 
        1000: "div.chip[data-coin='1000']",
        10000: "div.chip[data-coin='10000']",
        100000: "div.chip[data-coin='100000']",
        1000000: "div.chip[data-coin='1000000']",
        10000000: "div.chip[data-coin='10000000']",
        100000000: "div.chip[data-coin='100000000']"
    },
    // Betting targets (red/black)
    targets: {
        red: "td[data-id-number='40']",
        black: "td[data-id-number='39']"
    },
    // Last result display element
    resultHistory: '.roulette_number',
    // Fairness/Client Seed
    fairnessIcon: 'div.footer_wrap i.fa-balance-scale',
    seedModal: '#modal-window',
    seedModalInput: '#modal-window input#client_seed',
    seedModalChangeButton: '#modal-window button#process_change_client_seed',
    seedModalCloseButton: '#modal-window span.close-modal',
    // Roulette table
    rouletteTable: 'table.roulette',
    // Activation chip - IMPORTANT: This is the first chip we need to click to activate the board
    activationChip: "div.chip[data-id='0']" // Special chip used to activate the board
};

// Strategy constants
const BASE_PROGRESSION = Array.from({ length: 14 }, (_, i) => 100 * (2 ** i)); // Levels 0 to 13
const CHIP_DENOMINATIONS = [100000000, 10000000, 1000000, 100000, 10000, 1000, 100]; // Largest to smallest

// Define red/black number sets
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACK_NUMBERS = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

// Variables to track errors and wins (persistent counters between cycles)
let verificationErrorCount = 0; // Deposit verification error counter
let spinErrorCount = 0; // Spin error counter
let prevWinLevel = null; // Last win level
let pnl = 0; // Overall profit and loss tracker
let cycleCount = 0; // Cycle counter

// Asegurarse de que el directorio de capturas de pantalla exista
async function ensureScreenshotDir() {
    try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    } catch (error) {
        logger.warn(`Error creating screenshots directory: ${error.message}`);
    }
}

/**
 * Takes a screenshot for diagnostics with the given name
 * @param {string} name - Name for the screenshot file
 */
async function takeScreenshot(name) {
    const page = getPage();
    if (!page) return;
    
    try {
        await ensureScreenshotDir();
        const filename = `${name}_${Date.now()}.png`;
        const screenshotPath = path.join(SCREENSHOTS_DIR, filename);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Screenshot saved: ${screenshotPath}`);
    } catch (error) {
        logger.warn(`Failed to take screenshot: ${error.message}`);
    }
}

// =============================================
// === INTERACTION HELPER FUNCTIONS =====
// =============================================

/**
 * Forces a direct JavaScript click on an element - more reliable than Playwright's click
 * @param {string} selector - CSS selector of the element to click
 * @returns {Promise<boolean>} True if successful, false if failed
 */
async function forceJsClick(selector) {
    const page = getPage();
    if (!page) return false;
    
    try {
        // Execute the click directly in the browser context
        await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            if (element) {
                element.click();
                return true;
            }
            return false;
        }, selector);
        
        return true;
    } catch (error) {
        logger.error(`Failed to force JS click on ${selector}: ${error.message}`);
        return false;
    }
}

/**
 * Activates the betting board by clicking the 100 chip.
 * CRITICAL function that initializes the betting interaction.
 * @returns {Promise<boolean>} True if activated successfully, false otherwise.
 */
async function activateBoard() {
    const page = getPage();
    if (!page) return false;
    
    logger.info('Activating roulette table...');
    try {
        // Wait for the activation chip to be clickable
        await page.waitForSelector(SELECTORS.activationChip, { 
            state: 'visible', 
            timeout: 15000 
        });
        
        // IMPORTANT: This is the key step to properly activate the board
        // Use JavaScript direct click for better reliability (simulates the original Python script)
        await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (element) {
                // Direct click in JS context
                element.click();
                console.log("[ROULETTE] Activation chip clicked via JS");
            } else {
                console.error("[ROULETTE] Activation chip not found");
            }
        }, SELECTORS.activationChip);
        
        logger.info('Chip de 100 seleccionado para activar la mesa.');
        
        // Wait for the roulette table to be visible after activation
        await page.waitForSelector(SELECTORS.rouletteTable, {
            state: 'visible',
            timeout: 10000
        });
        
        logger.info('Mesa activada y lista.');
        // IMPORTANT: Pause after activation to let the table fully initialize
        await delay(1000); 
        return true;
    } catch (error) {
        logger.error(`Error al activar la mesa: ${error.message}`);
        return false;
    }
}

/**
 * Clears the betting table by clicking the CLEAR button.
 * Always start each bet level with a clean slate.
 * @returns {Promise<boolean>} True if cleared successfully, false otherwise.
 */
async function clearBet() {
    const page = getPage();
    if (!page) return false;
    
    logger.info('Clearing betting table...');
    try {
        // Wait for the Clear button to be visible
        await page.waitForSelector(SELECTORS.clearButton, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Click the Clear button using direct JavaScript execution
        // This is more reliable than Playwright's click, especially for UI elements
        await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            if (button) {
                // Direct click
                button.click();
                console.log("[ROULETTE] Clear button clicked via JS");
            }
        }, SELECTORS.clearButton);
        
        logger.info('Mesa limpiada (botón CLEAR presionado).');
        // Important pause after clearing to let UI update
        await delay(500);
        
        // Force input to 0 as additional verification - this is a key step from the Python script
        await page.evaluate((selector) => {
            const input = document.querySelector(selector);
            if (input) {
                // Set value directly
                input.value = '0.000000';
                // Trigger events for the page to recognize the change
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                console.log("[ROULETTE] Bet input forced to 0.000000");
            }
        }, SELECTORS.betAmountInput);
        
        // Additional pause for UI stability
        await delay(500);
        logger.debug("Bet input forzado a 0.000000");
        logger.info('Table cleared successfully.');
        return true;
    } catch (error) {
        logger.error(`Error al limpiar la mesa: ${error.message}`);
        return false;
    }
}

/**
 * Selects a chip with the specified value.
 * IMPROVED version with better chip selection verification
 * @param {number} chipValue - The chip value (100, 1000, etc.)
 * @returns {Promise<boolean>} True if selected successfully, false otherwise.
 */
async function selectChip(chipValue) {
    const page = getPage();
    if (!page) return false;
    
    logger.info(`Selecting chip of value ${chipValue}...`);
    
    try {
        // Get the appropriate selector for this chip value
        const chipSelector = SELECTORS.chips[chipValue];
        if (!chipSelector) {
            logger.warn(`No selector found for chip value ${chipValue}, using 100 chip as fallback.`);
            // Use 100 chip as fallback
            const fallbackSelector = SELECTORS.chips[100];
            
            // Wait for the chip to be visible and clickable
            await page.waitForSelector(fallbackSelector, { 
                state: 'visible', 
                timeout: 10000 
            });
            
            // IMPORTANT: Use direct JavaScript execution for clicking
            // This matches the Python implementation that was working
            await page.evaluate((selector) => {
                const chip = document.querySelector(selector);
                if (chip) {
                    // Direct click in JS context
                    chip.click();
                    console.log(`[ROULETTE] Fallback chip (100) clicked via JS`);
                }
            }, fallbackSelector);
            
            logger.info('Ficha de 100 seleccionada (fallback).');
        } else {
            // Wait for the selected chip to be visible and clickable
            await page.waitForSelector(chipSelector, { 
                state: 'visible', 
                timeout: 10000 
            });
            
            // IMPORTANT: Use direct JavaScript execution for clicking
            await page.evaluate((selector) => {
                const chip = document.querySelector(selector);
                if (chip) {
                    // Direct click in JS context
                    chip.click();
                    console.log(`[ROULETTE] Chip clicked via JS`);
                }
            }, chipSelector);
            
            logger.info(`Ficha de ${chipValue} seleccionada.`);
        }
        
        // IMPORTANT: Longer pause after chip selection - matches the Python script
        await delay(750);
        return true;
    } catch (error) {
        logger.error(`Error al seleccionar la ficha de ${chipValue}: ${error.message}`);
        return false;
    }
}

/**
 * Clicks a betting target (red/black) the specified number of times.
 * IMPROVED with better click reliability and timing.
 * @param {string} targetSelector - CSS selector of the target element.
 * @param {number} numClicks - Number of clicks to perform.
 * @returns {Promise<boolean>} True if all clicks were successful, false if any failed.
 */
async function clickTarget(targetSelector, numClicks = 1) {
    const page = getPage();
    if (!page) return false;
    
    // IMPORTANT: Match the delay timing from the Python script for better reliability
    const CLICK_DELAY = 1000; // 1 second between clicks (matching Python)
    let allClicksSuccessful = true;
    
    const targetName = targetSelector === SELECTORS.targets.red ? 'RED' : 'BLACK';
    logger.info(`Performing ${numClicks} click(s) on target ${targetName}...`);
    
    for (let i = 0; i < numClicks; i++) {
        try {
            // Wait for the target element to be visible/clickable
            await page.waitForSelector(targetSelector, { 
                state: 'visible', 
                timeout: 10000 
            });
            
            // IMPORTANT: Use direct JavaScript execution for clicking
            // This matches the Python implementation more closely
            await page.evaluate((selector) => {
                const target = document.querySelector(selector);
                if (target) {
                    // Direct click in JS context
                    target.click();
                    console.log(`[ROULETTE] Target clicked via JS`);
                }
            }, targetSelector);
            
            logger.debug(`Clic [${i + 1}/${numClicks}] en target ${targetName}.`);
            
            // Wait between clicks with the correct timing from Python
            if (i < numClicks - 1) {
                await delay(CLICK_DELAY);
            }
        } catch (error) {
            logger.error(`Error al clicar en ${targetName} (Intento ${i + 1}): ${error.message}`);
            allClicksSuccessful = false;
            break; // Stop clicking if one fails
        }
    }
    
    // Pause after clicking group - combined with Python's deposit_chip_with_selection timing
    const additionalDelay = 500 + (numClicks * 100); // Base 0.5s + 0.1s per click
    await delay(additionalDelay);
    
    return allClicksSuccessful;
}

/**
 * Gets the current numerical value of the bet amount input.
 * Improved parsing logic matching the Python implementation.
 * @returns {Promise<number>} The value as an integer, or 0 if error.
 */
async function getBetAmount() {
    const page = getPage();
    if (!page) return 0;
    
    try {
        // Read the current input value
        const value = await page.evaluate((selector) => {
            const input = document.querySelector(selector);
            return input ? input.value : null;
        }, SELECTORS.betAmountInput);
        
        // Handle case where input is not found
        if (value === null) {
            logger.warn(`Bet input ${SELECTORS.betAmountInput} not found.`);
            return 0;
        }
        
        // Process the value according to format - exact implementation from Python
        if (typeof value === 'string' && value.includes('.')) {
            // Value with format 0.XXXXXX - extract decimal part
            const decimalPart = value.split('.')[1] || '';
            return parseInt(decimalPart, 10) || 0;
        } else if (typeof value === 'string' && /^\d+$/.test(value)) {
            // Integer value
            return parseInt(value, 10);
        } else {
            logger.debug(`Bet value not recognized: '${value}'. Returning 0.`);
            return 0;
        }
    } catch (error) {
        logger.error(`Error getting bet amount: ${error.message}`);
        return 0;
    }
}

/**
 * Deposits chips using a selected chip multiple times.
 * Direct implementation of the Python deposit_chip_with_selection function.
 * @param {number} chipValue - Value of the selected chip
 * @param {number} times - Number of clicks to perform
 * @param {string} targetSelector - Selector for the target (red/black)
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function depositChipWithSelection(chipValue, times, targetSelector) {
    const targetName = targetSelector === SELECTORS.targets.red ? 'RED' : 'BLACK';
    logger.info(`Depositando ${chipValue} unidades (${times} clics) en ${targetName}.`);
    
    // Click the target the specified number of times
    const clickSuccess = await clickTarget(targetSelector, times);
    
    // Calculate delay after deposit (matching Python's timing)
    const postDepositDelay = 500 + (times * 100); // 0.5s + 0.1s per click
    await delay(postDepositDelay);
    
    return clickSuccess;
}

/**
 * Verifies that the deposited amount matches the desired amount and corrects if necessary.
 * Enhanced implementation with exact timing and retry logic from Python.
 * @param {number} desired - Target amount.
 * @param {string} targetSelector - Selector of the betting target.
 * @param {number} level - Current level for logging.
 * @param {number} maxAttempts - Maximum number of correction attempts.
 * @returns {Promise<number>} Final amount (verified), or -1 if completely fails.
 */
async function verifyDeposit(desired, targetSelector, level, maxAttempts = 5) {
    const page = getPage();
    if (!page) return -1;
    
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        // Wait for value to update - matching Python timing
        await delay(500);
        
        // Get current value
        const current = await getBetAmount();
        logger.info(`Verificación (Nivel ${level}, Intento ${attempts + 1}/${maxAttempts}): Depositado=${current}, Requerido=${desired}`);
        
        // Check if amount is correct
        if (current === desired) {
            logger.info(`✓ Depósito verificado OK en Nivel ${level}: ${current}.`);
            return current;
        } else if (current > desired) {
            // Accept if greater (could happen due to rounding or system limits)
            logger.warn(`⚠ Depósito (${current}) SUPERÓ el objetivo (${desired}) en Nivel ${level}. Aceptando.`);
            return current;
        }
        
        // If less, try to correct - just like in Python
        const missing = desired - current;
        logger.warn(`⚠ Falta depositar: ${missing} unidades.`);
        attempts++;
        
        // If last attempt, fail
        if (attempts >= maxAttempts) {
            logger.error(`❌ Error CRÍTICO de verificación en Nivel ${level} tras ${attempts} intentos. Limpiando mesa.`);
            await clearBet();
            return -1;
        }
        
        // Try to correct using 100 chip - exact logic from Python
        const clicksNeeded = Math.ceil(missing / 100);
        logger.info(`Intentando agregar ${clicksNeeded} clic(s) con ficha de 100.`);
        
        await selectChip(100);
        await depositChipWithSelection(100, clicksNeeded, targetSelector);
        
        // Wait longer after correction attempt - matching Python wait
        await delay(1000);
    }
    
    // This point shouldn't be reached, but just in case
    logger.error(`❌ Error final de verificación en Nivel ${level} tras ${maxAttempts} intentos.`);
    await clearBet();
    return -1;
}

/**
 * Makes the deposit for Level 0 (bet 100).
 * Exact implementation matching Python function.
 * @param {string} targetSelector - Selector of the betting target.
 * @returns {Promise<number>} 100 if successful, -1 if fails.
 */
async function depositForLevel0(targetSelector) {
    logger.info("--- Nivel 0 ---");
    
    // Clear the table first - essential to start fresh
    if (!await clearBet()) {
        logger.error("Could not clear table for Level 0.");
        return -1;
    }
    
    // Activate the board by selecting the activation chip - CRITICAL STEP
    if (!await activateBoard()) {
        logger.error("Fallo al activar tablero para Nivel 0.");
        return -1;
    }
    
    logger.info("Nivel 0: Apostando 100 (1 clic).");
    
    // Click on the target area (red/black) - Note: This relies on the activation already selecting the 100 chip
    if (!await clickTarget(targetSelector, 1)) {
        logger.error("Error clicking on target area for Level 0.");
        return -1;
    }
    
    await delay(1000); // Wait after clicking - matching Python timing
    
    // Verify deposit is correct
    const depositValue = await verifyDeposit(BASE_PROGRESSION[0], targetSelector, 0);
    if (depositValue === -1) {
        logger.error("Deposit verification failed for Level 0.");
        return -1;
    }
    
    return BASE_PROGRESSION[0]; // 100
}

/**
 * Makes the deposit for Level 1 (bet 200).
 * Exact implementation matching Python function.
 * @param {string} targetSelector - Selector of the betting target.
 * @returns {Promise<number>} 200 if successful, -1 if fails.
 */
async function depositForLevel1(targetSelector) {
    logger.info("--- Nivel 1 ---");
    
    // Clear the table first
    if (!await clearBet()) {
        logger.error("Could not clear table for Level 1.");
        return -1;
    }
    
    logger.info("Nivel 1: Depositando 200 (2 clics con ficha de 100).");
    
    // Select 100 chip
    if (!await selectChip(100)) {
        logger.error("Could not select chip for Level 1.");
        return -1;
    }
    
    // Make 2 clicks on the target area
    if (!await clickTarget(targetSelector, 2)) {
        logger.error("Error clicking on target area for Level 1.");
        return -1;
    }
    
    await delay(1000); // Wait after clicks - matching Python timing
    
    // Verify deposit is correct
    const depositValue = await verifyDeposit(BASE_PROGRESSION[1], targetSelector, 1);
    if (depositValue === -1) {
        logger.error("Deposit verification failed for Level 1.");
        return -1;
    }
    
    return BASE_PROGRESSION[1]; // 200
}

/**
 * Makes the deposit for levels 2-13 using greedy algorithm.
 * Exact implementation matching Python function.
 * @param {number} level - Bet level (2-13).
 * @param {string} targetSelector - Selector of the betting target.
 * @returns {Promise<number>} The target amount if successful, -1 if fails.
 */
async function depositForLevelGeneric(level, targetSelector) {
    logger.info(`--- Nivel ${level} ---`);
    
    // Clear the table first
    if (!await clearBet()) {
        logger.error(`Could not clear table for Level ${level}.`);
        return -1;
    }
    
    // Calculate target amount for this level
    const desired = BASE_PROGRESSION[level];
    logger.info(`Nivel ${level}: Objetivo de depósito = ${desired} unidades.`);
    
    // Calculate how to deposit it using the greedy algorithm
    let remaining = desired;
    
    // Iterate through each chip denomination from largest to smallest - exact Python logic
    for (const chip of CHIP_DENOMINATIONS) {
        if (remaining <= 0) break; // Already deposited everything
        
        if (remaining >= chip) {
            // Calculate how many clicks we need with this chip
            const count = Math.floor(remaining / chip);
            
            if (count > 0) {
                logger.info(`Nivel ${level}: Usando ficha de ${chip}, ${count} clic(s).`);
                
                // Select this chip
                if (!await selectChip(chip)) {
                    logger.warn(`Could not select ${chip} chip, trying to continue...`);
                    continue;
                }
                
                // Make the necessary clicks using deposit function
                if (!await depositChipWithSelection(chip, count, targetSelector)) {
                    logger.warn(`Error clicking with ${chip} chip, trying to continue...`);
                    // Try to verify how much was actually deposited
                    const actual = await getBetAmount();
                    remaining = desired - actual;
                    logger.info(`Deposited: ${actual}, Remaining: ${remaining}`);
                } else {
                    // Successful clicks, update remaining
                    remaining -= chip * count;
                }
                
                await delay(500); // Small pause between denominations - matching Python
            }
        }
    }
    
    // If anything remains to deposit after the greedy algorithm
    if (remaining > 0) {
        logger.warn(`${remaining} units remain undeposited. Verification will try to correct.`);
    }
    
    logger.info(`Nivel ${level}: Depósito greedy completado. Verificando...`);
    // Wait before verification - matching Python
    await delay(1500);
    
    // Verify deposit is correct
    const depositValue = await verifyDeposit(desired, targetSelector, level);
    if (depositValue === -1) {
        logger.error(`Deposit verification failed for Level ${level}.`);
        return -1;
    }
    
    return desired;
}

/**
 * Clicks the SPIN button to spin the roulette.
 * Enhanced with better click reliability and timing.
 * @returns {Promise<boolean>} True if successful, false if fails.
 */
async function spin() {
    const page = getPage();
    if (!page) return false;
    
    logger.info('Starting roulette spin...');
    
    try {
        // Wait for the button to be clickable
        await page.waitForSelector(SELECTORS.spinButton, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Small pause before clicking - matching Python timing
        await delay(500);
        
        // Click the SPIN button using JavaScript - most reliable method
        await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            if (button) {
                button.click();
                console.log("[ROULETTE] SPIN button clicked via JS");
            }
        }, SELECTORS.spinButton);
        
        logger.info('¡Ruleta girando! 🎲');
        return true;
    } catch (error) {
        logger.error(`Error spinning roulette: ${error.message}`);
        return false;
    }
}

/**
 * Waits for and gets the roulette result.
 * Enhanced with better result extraction matching Python.
 * @returns {Promise<number|null>} The resulting number, or null if fails.
 */
async function getResult() {
    const page = getPage();
    if (!page) return null;
    
    const RESULT_WAIT_TIME = 6000; // 6 seconds - exactly matching Python
    logger.info(`Esperando ${RESULT_WAIT_TIME/1000} segundos por el resultado...`);
    
    // Wait for result to appear
    await delay(RESULT_WAIT_TIME);
    
    try {
        // Get all result history elements - matching Python approach
        const historyTexts = await page.$$eval(SELECTORS.resultHistory, (elements) =>
            elements.map(el => el.textContent.trim())
        );
        
        if (!historyTexts || historyTexts.length === 0) {
            logger.warn("No se encontraron elementos 'roulette_number'.");
            return null;
        }
        
        // Take the last result (most recent)
        const lastResultText = historyTexts[historyTexts.length - 1];
        
        // Extract the number from the text using digit extraction - matching Python
        const numberMatch = lastResultText.match(/\d+/);
        if (numberMatch && numberMatch[0]) {
            const resultNumber = parseInt(numberMatch[0], 10);
            logger.info(`Resultado obtenido: ${resultNumber} 🎯`);
            return resultNumber;
        } else {
            logger.warn(`No se extrajo un número válido del texto: '${lastResultText}'`);
            return null;
        }
    } catch (error) {
        logger.error(`Error getting result: ${error.message}`);
        return null;
    }
}

/**
 * Determines if the result is a win for the chosen color.
 * Exact implementation from Python.
 * @param {number|null} result - The resulting number.
 * @param {'red'|'black'} target - The target color.
 * @returns {boolean} True if win, false if not.
 */
function isWin(result, target) {
    // Special cases
    if (result === null || result === 0) return false;
    
    // Win according to color - using Set.has for O(1) lookup
    if (target === 'red') {
        return RED_NUMBERS.has(result);
    } else if (target === 'black') {
        return BLACK_NUMBERS.has(result);
    }
    
    // Unknown target
    logger.warn(`Unknown target in isWin: ${target}`);
    return false;
}

/**
 * Calculates the profit/loss for a completed cycle.
 * @param {number|null} winLevel - The level of victory (0-13), or null if lost at level 13
 * @param {number} cumulative - The cumulative cost of all bets made in this cycle
 * @returns {number} The profit (positive) or loss (negative) for this cycle
 */
function calculateCycleProfit(winLevel, cumulative) {
    // If there was a win at any level
    if (winLevel !== null) {
        // Bet amount for the winning level
        const betWon = BASE_PROGRESSION[winLevel];
        // Profit = 2 * Bet - Total Cost (assuming 2x payout)
        return (2 * betWon) - cumulative;
    } else {
        // Loss at level 13 - total loss is the accumulated bet amount
        return -cumulative;
    }
}

/**
 * Generates a new random hexadecimal client seed.
 * @param {number} [length=16] - Length of the seed.
 * @returns {string} The new seed.
 */
function generateNewSeed(length = 16) {
    // crypto.randomBytes needs half the length (bytes -> hex)
    const bytes = Math.ceil(length / 2);
    return crypto.randomBytes(bytes).toString('hex').slice(0, length);
}

/**
 * Changes the Client Seed through the Fairness modal.
 * Enhanced with better modal interaction reliability.
 * @returns {Promise<boolean>} True if successful, false if fails.
 */
async function changeClientSeed() {
    const page = getPage();
    if (!page) return false;
    
    logger.info("Intentando cambiar el Client Seed...");
    let modalWasOpened = false;
    
    try {
        // Take screenshot before starting
        await takeScreenshot('before_seed_change');
        
        // 1. Open the Fairness modal - find and click the icon
        logger.debug("Buscando icono de Fairness...");
        await page.waitForSelector(SELECTORS.fairnessIcon, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Click the icon using JavaScript for reliability
        await page.evaluate((selector) => {
            const icon = document.querySelector(selector);
            if (icon) {
                icon.click();
                console.log("[ROULETTE] Fairness icon clicked via JS");
            }
        }, SELECTORS.fairnessIcon);
        
        modalWasOpened = true;
        logger.info("Modal de Fairness abierto. Esperando contenido...");
        
        // Wait for modal to be visible
        await page.waitForSelector(SELECTORS.seedModal, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Take screenshot of modal
        await takeScreenshot('fairness_modal_open');
        
        // Additional wait to ensure complete loading - matching Python
        await delay(2500);
        
        // 2. Find seed input field
        logger.debug("Buscando campo Client Seed...");
        await page.waitForSelector(SELECTORS.seedModalInput, { 
            state: 'visible', 
            timeout: 20000 
        });
        
        // 3. Generate new seed
        const newSeed = generateNewSeed(16);
        logger.info(`Nuevo Client Seed generado: ${newSeed}`);
        
        // 4. Clear field and input new seed
        logger.debug("Estableciendo nuevo seed...");
        
        // Clear and fill the input field
        await page.evaluate((selector, seed) => {
            const input = document.querySelector(selector);
            if (input) {
                input.value = ''; // Clear
                input.value = seed; // Set
                // Trigger events
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                console.log("[ROULETTE] New seed set via JS");
            }
        }, SELECTORS.seedModalInput, newSeed);
        
        logger.info("Nuevo seed introducido.");
        await delay(500); // Pause after setting seed - matching Python
        
        // 5. Click change button
        logger.debug("Buscando botón 'CHANGE CLIENT SEED'...");
        await page.waitForSelector(SELECTORS.seedModalChangeButton, { 
            state: 'visible', 
            timeout: 10000 
        });
        
        // Take screenshot before clicking change button
        await takeScreenshot('before_change_seed_button');
        
        // Click the button using JavaScript
        await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            if (button) {
                button.click();
                console.log("[ROULETTE] CHANGE CLIENT SEED button clicked via JS");
            }
        }, SELECTORS.seedModalChangeButton);
        
        logger.info("Botón 'CHANGE CLIENT SEED' presionado.");
        
        // Wait for processing - matching Python timing
        await delay(2500);
        
        // Take screenshot after change
        await takeScreenshot('after_seed_change');
        
        logger.info("✅ Client Seed cambiado exitosamente!");
        return true;
    } catch (error) {
        logger.error(`Error durante el cambio de Client Seed: ${error.message}`);
        // Take error screenshot
        await takeScreenshot('error_seed_change');
        return false;
    } finally {
        // 6. Close the modal if it was opened - always run this cleanup
        if (modalWasOpened && page) {
            try {
                logger.debug("Intentando cerrar el modal de Fairness (Finally block)...");
                await page.waitForSelector(SELECTORS.seedModalCloseButton, { 
                    state: 'visible', 
                    timeout: 5000 
                });
                
                // Click the close button using JavaScript
                await page.evaluate((selector) => {
                    const button = document.querySelector(selector);
                    if (button) {
                        button.click();
                        console.log("[ROULETTE] Modal close button clicked via JS");
                    }
                }, SELECTORS.seedModalCloseButton);
                
                logger.info("Modal de Fairness cerrado.");
                await delay(1000); // Wait after closing - matching Python
            } catch (closeError) {
                logger.warn(`Advertencia: No se pudo cerrar el modal de Fairness automáticamente: ${closeError.message}`);
                // A subsequent refresh should fix it
            }
        }
    }
}

/**
 * Executes ONE complete cycle of the roulette strategy.
 * This function will be called repeatedly by the Orchestrator.
 * 
 * @returns {Promise<object>} Cycle result:
 *  { outcome: 'win', level: N } - Victory at level N
 *  { outcome: 'loss' } - Loss at level 13
 *  { outcome: 'error', message: '...' } - Critical error in the cycle
 */
async function playOneCycle() {
    cycleCount++;
    logger.info('===========================================');
    logger.info(`===== INICIO CICLO RULETA #${cycleCount} | PnL Actual: ${pnl} =====`);
    logger.info('===========================================');
    
    const page = getPage();
    if (!page) {
        logger.error('❌ Cannot play: page not available.');
        return { outcome: 'error', message: 'Page not available' };
    }
    
    let betAmountLvl = -1;
    let spinSuccess = false;
    let result = null;
    let didWin = false;
    let cumulative = 0; // Track the total cost of bets in this cycle
    let winLevel = null; // Store the win level temporarily without updating prevWinLevel
    
    try {
        // IMPORTANT: REMOVED the navigateTo call that was causing issues
        // We rely on the Orchestrator or handleSeedAndRefresh to ensure we're on the right page
        
        // Randomly choose between red and black for this round
        const targetChoice = Math.random() < 0.5 ? 'red' : 'black';
        const targetSelector = SELECTORS.targets[targetChoice];
        logger.info(`New cycle. Selected target: ${targetChoice.toUpperCase()}`);
        
        // ===== LEVEL 0 =====
        logger.info("Starting Level 0 (bet 100)...");
        betAmountLvl = await depositForLevel0(targetSelector);
        if (betAmountLvl === -1) {
            verificationErrorCount++;
            logger.error(`Error de verificación en ciclo ${cycleCount}, Nivel 0. Contador: ${verificationErrorCount}/5`);
            return { outcome: 'error', message: 'Deposit verification failed at Level 0' };
        }
        
        // Add Level 0 bet to cumulative cost
        cumulative += BASE_PROGRESSION[0];
        
        // Spin the roulette
        spinSuccess = await spin();
        if (!spinSuccess) {
            spinErrorCount++;
            logger.error(`Error al presionar SPIN en ciclo ${cycleCount}, Nivel 0. Contador: ${spinErrorCount}/3`);
            return { outcome: 'error', message: 'Spin failed at Level 0' };
        }
        
        // Get result
        result = await getResult();
        didWin = isWin(result, targetChoice);
        
        // Check for victory
        if (didWin) {
            logger.info(`🎉 VICTORY in Level 0! Result: ${result}`);
            // Reset error counters since we had success
            verificationErrorCount = 0;
            spinErrorCount = 0;
            // Store the win level WITHOUT updating prevWinLevel yet (critical fix)
            winLevel = 0;
            
            // Calculate profit and update global PnL
            const cycleProfit = calculateCycleProfit(0, cumulative);
            pnl += cycleProfit;
            logger.info(`Cycle profit: ${cycleProfit}. Total PnL: ${pnl}`);
            
            return { outcome: 'win', level: 0 };
        } else {
            logger.info(`😔 Loss in Level 0 (Result: ${result}). Moving to Level 1.`);
            await delay(1000); // Wait before next level - matching Python
        }
        
        // ===== LEVELS 1 TO 13 =====
        for (let level = 1; level <= 13; level++) {
            logger.info(`Moving to Level ${level}...`);
            
            // Deposit appropriate amount based on level
            if (level === 1) {
                betAmountLvl = await depositForLevel1(targetSelector);
            } else {
                betAmountLvl = await depositForLevelGeneric(level, targetSelector);
            }
            
            // Check if deposit was successful
            if (betAmountLvl === -1) {
                verificationErrorCount++;
                logger.error(`Error de verificación en ciclo ${cycleCount}, Nivel ${level}. Contador: ${verificationErrorCount}/5`);
                return { outcome: 'error', message: `Deposit verification failed at Level ${level}` };
            }
            
            // Add this level's bet to cumulative cost
            cumulative += BASE_PROGRESSION[level];
            
            // Spin the roulette
            spinSuccess = await spin();
            if (!spinSuccess) {
                spinErrorCount++;
                logger.error(`Error al presionar SPIN en ciclo ${cycleCount}, Nivel ${level}. Contador: ${spinErrorCount}/3`);
                return { outcome: 'error', message: `Spin failed at Level ${level}` };
            }
            
            // Get result
            result = await getResult();
            didWin = isWin(result, targetChoice);
            
            // Check for victory
            if (didWin) {
                logger.info(`🎉 VICTORY in Level ${level}! Result: ${result}`);
                // Reset error counters since we had success
                verificationErrorCount = 0;
                spinErrorCount = 0;
                // Store the win level WITHOUT updating prevWinLevel yet (critical fix)
                winLevel = level;
                
                // Calculate profit and update global PnL
                const cycleProfit = calculateCycleProfit(level, cumulative);
                pnl += cycleProfit;
                logger.info(`Cycle profit: ${cycleProfit}. Total PnL: ${pnl}`);
                
                return { outcome: 'win', level: level };
            } else {
                logger.info(`Pérdida en Nivel ${level} (Resultado: ${result}) 😔.`);
                
                // If not the last level, prepare for the next
                if (level < 13) {
                    logger.info(`Preparing Level ${level + 1}...`);
                    await delay(1000); // Wait before next level - matching Python
                } else {
                    logger.info("Pérdida en Nivel 13 😢.");
                }
            }
        }
        
        // If we get here, we lost at all levels (0-13)
        logger.info(`Ciclo #${cycleCount} finalizado. PÉRDIDA Nivel 13 ❌.`);
        // Reset error counters since the cycle completed without technical issues
        verificationErrorCount = 0;
        spinErrorCount = 0;
        
        // Calculate loss and update global PnL
        const cycleLoss = calculateCycleProfit(null, cumulative);
        pnl += cycleLoss;
        logger.info(`Cycle loss: ${cycleLoss}. Total PnL: ${pnl}`);
        
        return { outcome: 'loss' };
    } catch (error) {
        logger.error(`❌ Fatal error during roulette cycle: ${error.message}`);
        logger.error(error.stack);
        
        // Take screenshot for diagnostics
        await takeScreenshot('error_roulette_cycle');
        
        return { outcome: 'error', message: `Unexpected error: ${error.message}` };
    } finally {
        logger.info('===========================================');
        logger.info('======== FIN CICLO RULETA =========');
        logger.info('===========================================');
    }
}

/**
 * Handles the logic of seed change and refresh based on accumulated errors or win patterns.
 * This function should be called by the Orchestrator after each cycle.
 * CRITICAL FIX: Now correctly uses the previous win level for streak logic.
 * 
 * @param {object} cycleResult - Result of the last cycle
 * @returns {Promise<boolean>} True if a refresh/change was performed, false if not
 */
async function handleSeedAndRefresh(cycleResult) {
    logger.info("Evaluando necesidad de cambio de seed/refresco...");
    
    // Store previous win level before any changes
    const previousLevelBeforeCheck = prevWinLevel;
    let refreshPerformed = false;
    
    // Case 1: Accumulated deposit verification errors - exact logic from Python
    if (verificationErrorCount >= 5) {
        logger.warn(`⚠️ ${verificationErrorCount}/5 errores de verificación detectados. Cambiando seed y refrescando...`);
        const seedChanged = await changeClientSeed();
        if (seedChanged) {
            logger.info("Client Seed cambiado exitosamente antes de refrescar.");
        } else {
            logger.warn("Fallo al cambiar Client Seed. Refrescando de todas formas.");
        }
        // Provide true as second parameter to force refresh
        await navigateTo(ROULETTE_URL, true);
        logger.info("Página refrescada debido a errores de verificación.");
        verificationErrorCount = 0; // Reset counter
        prevWinLevel = null; // Reset state
        await delay(5000); // Wait after refresh - matching Python
        refreshPerformed = true;
        return true;
    }
    
    // Case 2: Accumulated spin errors - exact logic from Python
    if (spinErrorCount >= 3) {
        logger.warn(`⚠️ ${spinErrorCount}/3 errores de SPIN detectados. Cambiando seed y refrescando...`);
        const seedChanged = await changeClientSeed();
        if (seedChanged) {
            logger.info("Client Seed cambiado exitosamente antes de refrescar.");
        } else {
            logger.warn("Fallo al cambiar Client Seed. Refrescando de todas formas.");
        }
        // Provide true as second parameter to force refresh
        await navigateTo(ROULETTE_URL, true);
        logger.info("Página refrescada debido a errores de SPIN.");
        spinErrorCount = 0;
        prevWinLevel = null;
        await delay(5000);
        refreshPerformed = true;
        return true;
    }
    
    // Case 3: High-level victory breaks a streak - THIS IS THE CRITICAL FIX
    if (cycleResult && cycleResult.outcome === 'win' && cycleResult.level >= 3) {
        // Use previousLevelBeforeCheck for the comparison, NOT the current level
        if (previousLevelBeforeCheck === null || previousLevelBeforeCheck < 3) {
            logger.info(`⚠️ Victoria Nivel ${cycleResult.level} rompe racha (Anterior: ${previousLevelBeforeCheck === null ? 'None' : previousLevelBeforeCheck}). Preparando para refrescar...`);
            logger.info("Esperando 3 segundos antes de cambiar seed y refrescar...");
            await delay(3000); // Wait before change - matching Python
            
            const seedChanged = await changeClientSeed();
            if (seedChanged) {
                logger.info("Client Seed cambiado exitosamente antes de refrescar.");
            } else {
                logger.warn("Fallo al cambiar Client Seed. Refrescando de todas formas.");
            }
            
            // Provide true as second parameter to force refresh
            await navigateTo(ROULETTE_URL, true);
            logger.info("Página refrescada debido a victoria de alto nivel que rompe racha.");
            prevWinLevel = null; // Reset prevWinLevel AFTER refresh
            await delay(5000);
            refreshPerformed = true;
            return true;
        } else {
            logger.info(`Victoria Nivel ${cycleResult.level}, pero racha >=3 continúa (Anterior: ${previousLevelBeforeCheck}). No refrescar.`);
        }
    } else if (cycleResult && cycleResult.outcome === 'win' && cycleResult.level < 3) {
        logger.info(`Victoria Nivel ${cycleResult.level} (<3). No refrescar.`);
    } else if (cycleResult && cycleResult.outcome === 'loss') {
        logger.info("Pérdida en Nivel 13. No refrescar por esta condición.");
    }
    
    // Update prevWinLevel ONLY if no refresh occurred
    if (!refreshPerformed) {
        // Update based on the outcome of the cycle just finished
        if (cycleResult && cycleResult.outcome === 'win') {
            // NOW we update prevWinLevel with the current cycle's level
            prevWinLevel = cycleResult.level;
            logger.debug(`prevWinLevel actualizado a ${prevWinLevel}`);
        } else if (cycleResult && cycleResult.outcome === 'loss') {
            // On loss, reset prevWinLevel to null
            prevWinLevel = null;
            logger.debug("prevWinLevel reseteado a null después de pérdida");
        }
        
        logger.info("No se requiere cambio de seed ni refresco en este ciclo.");
        return false; // No refresh performed
    }
    
    // If we get here, refresh was performed and prevWinLevel was reset above
    return true;
}

/**
 * Returns the current total profit and loss value
 * @returns {number} The current PnL value
 */
function getCurrentPnL() {
    return pnl;
}

/**
 * Resets the profit and loss counter to zero
 * This is useful when starting fresh or after a withdrawal
 */
function resetPnL() {
    logger.info(`Resetting PnL from ${pnl} to 0`);
    pnl = 0;
}

/**
 * Resets the error counters and state variables
 * Useful for calling after a prolonged stop or error
 */
function resetState() {
    logger.info("Resetting RoulettePlayer state...");
    verificationErrorCount = 0;
    spinErrorCount = 0;
    prevWinLevel = null;
}

/**
 * Gets the current error counters
 * Useful for diagnostics in Orchestrator
 * @returns {object} Current state of the counters
 */
function getErrorCounts() {
    return {
        verificationErrorCount,
        spinErrorCount,
        prevWinLevel
    };
}

// Export the functions that will be used by the Orchestrator
export { 
    playOneCycle,            // Principal: execute a complete cycle
    handleSeedAndRefresh,    // Manage seed change and refresh
    changeClientSeed,        // Change seed manually
    resetState,              // Reset internal state of the module
    getErrorCounts,          // Get counters for diagnostics
    getCurrentPnL,           // Get the current PnL value 
    resetPnL                 // Reset the PnL counter
};