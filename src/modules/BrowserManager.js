// src/modules/BrowserManager.js

import fs from 'fs/promises'; // For file system operations (creating directory)
import path from 'path';     // For path handling
import { connect } from 'puppeteer-real-browser'; // Main function from the library
import { getConfig } from './ConfigManager.js'; // To get configuration (userDataDir path, headless)
import logger from '../utils/logger.js'; // Our custom logger
// Import delay for use in navigateTo
import { delay } from '../utils/helpers.js';

// Global variables to maintain browser and main page instances
let browser = null;
let page = null;
// Set to track which URLs have had zoom applied
const zoomAppliedUrls = new Set();

// Configurable constants for viewport and zoom
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const ZOOM_LEVEL = '40%'; // Literal as requested

// Folder for screenshots
const SCREENSHOTS_DIR = './screenshots';

/**
 * Injection script that ensures zoom is correctly applied to the page
 * This is THE DEFINITIVE SOLUTION - a single method that uses the zoom property directly
 * @param {string} zoomLevel - Zoom level as a string (e.g., '30%')
 */
function getZoomInjectionScript(zoomLevel) {
  return `
    (function() {
      // Function to apply zoom to the document
      function applyZoom() {
        // 1. Apply zoom to body
        document.body.style.zoom = "${zoomLevel}";
        
        // 2. Ensure other styles don't interfere
        document.body.style.transformOrigin = "top left";
        document.body.style.margin = "0";
        document.body.style.padding = "0";
        
        console.log("[TronpickMaster] Zoom applied: ${zoomLevel}");
      }
      
      // Apply zoom immediately
      applyZoom();
      
      // Set up MutationObserver to maintain zoom if the page changes
      const observer = new MutationObserver(function(mutations) {
        // If we detect DOM changes, re-apply zoom
        if (document.body.style.zoom !== "${zoomLevel}") {
          applyZoom();
        }
      });
      
      // Observe changes in the document
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      
      // Also re-apply on load events
      window.addEventListener('load', applyZoom);
      window.addEventListener('DOMContentLoaded', applyZoom);
      
      // Return confirmation
      return "ZOOM_APPLIED";
    })();
  `;
}

/**
 * Hides unwanted UI elements on various pages
 * This creates a more streamlined experience for automated usage
 * @returns {Promise<boolean>} True if successful, false if failed
 */
async function hideUnwantedElements() {
  const page = getPage();
  if (!page) {
    logger.error('Cannot hide elements: Page not available');
    return false;
  }

  try {
    // Get current URL to determine which elements to hide
    const currentUrl = await page.url();
    logger.info(`Hiding unwanted elements for: ${currentUrl}`);

    // Execute JavaScript in page context to hide elements
    // The CSS is inserted and the function runs in one evaluation call
    await page.evaluate((url) => {
      // Helper function to create and inject CSS
      function addCSS(cssRules) {
        // Create a style element
        const style = document.createElement('style');
        style.id = 'tronpickmaster-style';
        style.textContent = cssRules;
        document.head.appendChild(style);
        console.log('[TronpickMaster] Injected custom CSS');
      }

      // CSS rules to hide elements on all pages
      let cssRules = `
        /* Hide footer on all pages */
        footer.footer, .footer, .copy-right_text {
          display: none !important;
        }
      `;

      // Add page-specific CSS rules based on the URL
      if (url.includes('/roulette.php')) {
        cssRules += `
          /* Hide bet history table on roulette page */
          #my_bets_table, div#my_bets_table, .bets_table {
            display: none !important;
          }
        `;
      } else if (url.includes('/faucet.php')) {
        cssRules += `
          /* Hide level system table on faucet page */
          .history_tbl, table.history_tbl {
            display: none !important;
          }
        `;
      } else if (url.includes('/settings.php')) {
        cssRules += `
          /* Hide IP history table on settings page */
          .table.table-striped.bets_table {
            display: none !important;
          }
        `;
      }

      // Remove existing style if it exists
      const existingStyle = document.getElementById('tronpickmaster-style');
      if (existingStyle) {
        existingStyle.remove();
      }

      // Add the CSS to the page
      addCSS(cssRules);

      // Return success message
      return 'Elements hidden successfully';
    }, currentUrl);

    logger.info('Unwanted elements hidden successfully');
    return true;
  } catch (error) {
    logger.error(`Error hiding unwanted elements: ${error.message}`);
    return false;
  }
}

// Function to set up automatic hiding after navigation
async function setupAutoElementHiding() {
  const page = getPage();
  if (!page) {
    logger.error('Cannot setup auto hiding: Page not available');
    return false;
  }

  try {
    // Create a MutationObserver setup in page context to ensure elements stay hidden
    await page.evaluate(() => {
      // Create and run a function that will persist through navigation
      window.__tronpickmaster_setupObserver = function() {
        // If observer already exists, disconnect it
        if (window.__tronpickmaster_observer) {
          window.__tronpickmaster_observer.disconnect();
        }

        // Create a new MutationObserver
        window.__tronpickmaster_observer = new MutationObserver((mutations) => {
          // Re-apply our style whenever DOM changes
          const style = document.getElementById('tronpickmaster-style');
          if (!style) {
            // If our style is gone, re-apply it
            const event = new CustomEvent('tronpickmaster:reapplystyle');
            document.dispatchEvent(event);
          }
        });

        // Start observing
        window.__tronpickmaster_observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });

        console.log('[TronpickMaster] Element hiding observer setup complete');
      };

      // Run the setup immediately
      window.__tronpickmaster_setupObserver();
    });

    // Setup an event listener to reapply styles when needed
    await page.evaluate(() => {
      document.addEventListener('tronpickmaster:reapplystyle', () => {
        console.log('[TronpickMaster] Reapplying element hiding styles...');
        // This event will be dispatched by the observer if our styles are removed
        // The hideUnwantedElements function will be called again by the navigateTo function
      });
    });

    logger.info('Auto-hiding setup complete');
    return true;
  } catch (error) {
    logger.error(`Error setting up auto hiding: ${error.message}`);
    return false;
  }
}

// Initialize element hiding during browser launch
async function initializeElementHiding() {
  logger.info('Setting up automatic element hiding...');
  
  try {
    // Setup the observer for continuous element hiding
    await setupAutoElementHiding();
    
    // Register a handler for navigation events to hide elements after navigation
    const page = getPage();
    if (page) {
      page.on('framenavigated', async (frame) => {
        // Only process main frame navigation
        if (frame === page.mainFrame()) {
          // Small delay to ensure page is fully loaded
          await delay(1000);
          
          // Hide elements
          await hideUnwantedElements();
        }
      });
      
      logger.info('Element hiding setup successfully.');
    } else {
      logger.warn('Could not set up element hiding: page not available');
    }
  } catch (error) {
    logger.error(`Error setting up element hiding: ${error.message}`);
  }
}

/**
 * Ensures screenshot directory exists
 */
async function ensureScreenshotDir() {
  try {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  } catch (error) {
    logger.warn(`Error creating screenshots directory: ${error.message}`);
  }
}

/**
 * Takes a screenshot for diagnostics
 * @param {string} name - Name for the screenshot file
 */
async function takeScreenshot(name) {
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

/**
 * Launches a Chromium browser instance using puppeteer-real-browser.
 * Sets up the instance, ensures userDataDir, and adjusts the viewport.
 */
async function launchBrowser() {
  // If there's already an instance, don't do anything else
  if (browser) {
    logger.warn('Browser is already started.');
    return;
  }

  try {
    const config = getConfig(); // Get configuration (headless, userDataDir, etc.)
    logger.info('Starting the browser...');

    const chromeExecutablePath = '/usr/bin/chromium-browser'; // Confirmed path in Ubuntu system
    logger.info(`Using Chromium path: ${chromeExecutablePath}`);

    // Ensure directory for storing profile data exists
    const absoluteUserDataPath = path.resolve(config.userDataDirPath); // Convert to absolute path
    logger.info(`Ensuring user data directory exists: ${absoluteUserDataPath}`);
    await fs.mkdir(absoluteUserDataPath, { recursive: true }); // Create directory recursively if it doesn't exist

    // Options for browser connection/launch
    const options = {
      headless: config.headlessMode, // false to see the window in the VM
      turnstile: config.enableTurnstile, // Try to automatically solve Cloudflare Turnstile
      customConfig: {
        userDataDir: absoluteUserDataPath, // Directory to save session, cookies, etc.
        chromePath: chromeExecutablePath, // Specify executable path
      },
      // Arguments passed to Chromium at launch
      args: [
        '--no-sandbox', // Necessary in many Linux environments
        '--disable-setuid-sandbox', // Related to sandbox in Linux
        '--disable-dev-shm-usage', // Avoid problems with limited shared memory
        '--disable-accelerated-2d-canvas', // Can help with graphics problems
        '--no-first-run', // Avoid first run dialogs
        '--no-zygote', // Can help in some Linux environments
        '--disable-gpu', // Disable hardware acceleration (useful in servers/VMs)
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}` // Set initial size
      ],
      // Force use of VM display instead of a virtual display (Xvfb)
      // Essential for headless:false to work in your VM with desktop
      disableXvfb: true,
    };

    // Connect/Launch the real browser instance
    logger.debug('Calling puppeteer-real-browser connect()...');
    const response = await connect(options);
    browser = response.browser; // Save browser instance
    page = response.page; // Save initial page instance

    // Verify that we got the instances
    if (!browser || !page) {
       throw new Error('Could not get browser or page instance from puppeteer-real-browser.');
    }

    // *** VIEWPORT CONFIGURATION ***
    try {
        logger.info(`Setting viewport to ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}...`);
        await page.setViewport({
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT
        });
        
        logger.info(`Viewport set to ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}.`);
        
        // Brief pause to allow viewport to update
        await delay(1000);
    } catch (viewportError) {
         logger.warn(`Could not set viewport: ${viewportError.message}`);
    }
    
    // Set more generous default navigation timeout (60 seconds)
    page.setDefaultNavigationTimeout(60000);

    logger.info(`Browser successfully started. Headless: ${config.headlessMode}, Viewport: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`);
    logger.info(`Zoom of ${ZOOM_LEVEL} will be applied to all pages.`);

    // Initialize element hiding
    await initializeElementHiding();

    // Add a listener to detect if the browser closes unexpectedly
    browser.on('disconnected', () => {
      logger.error('The browser has disconnected unexpectedly!');
      // Clean up global variables
      browser = null;
      page = null;
    });

  } catch (error) {
    logger.error(`CRITICAL error starting browser: ${error.message}`);
    logger.error(error.stack); // Log full stack trace for debugging
    throw error; // Rethrow the error for the Orchestrator to catch and stop
  }
} // End launchBrowser

/**
 * Applies zoom by injecting a script into the page.
 * This is the only zoom method we use to avoid conflicts.
 * @returns {Promise<boolean>} True if applied correctly, false in case of error
 */
async function applyZoom() {
    if (!page) return false;
    
    try {
        // Apply zoom using script injection
        const result = await page.evaluate(getZoomInjectionScript(ZOOM_LEVEL));
        
        if (result === "ZOOM_APPLIED") {
            logger.info(`Zoom set to ${ZOOM_LEVEL} using definitive solution.`);
            return true;
        } else {
            logger.warn(`Unexpected response when applying zoom: ${result}`);
            return false;
        }
    } catch (error) {
        logger.error(`Error applying zoom: ${error.message}`);
        return false;
    }
}

/**
 * Navigates to a specific URL intelligently.
 * Avoids reloading the page if already at the destination URL, unless forceRefresh is indicated.
 * @param {string} url - The URL to navigate to.
 * @param {boolean} [forceRefresh=false] - If true, forces reload even if already at the URL.
 */
async function navigateTo(url, forceRefresh = false) {
  // Check if page is available
  if (!page) {
    logger.error('Navigation attempt, but page is not initialized.');
    throw new Error('Browser page is not available.');
  }
  
  try {
    const currentURL = page.url(); // Get current URL
    
    // New implementation with forceRefresh:
    // If we're at the destination URL and NOT forcing refresh, do nothing
    if (currentURL === url && !forceRefresh) {
      logger.info(`Already at ${url}. No navigation required.`);
      // Re-apply zoom just to ensure it's maintained
      await applyZoom();
      // Hide unwanted elements on current page
      await hideUnwantedElements();
      // Small pause
      await delay(150);
      return;
    }
    
    // If we're at the URL but ARE forcing refresh, do a reload
    if (currentURL === url && forceRefresh) {
      logger.info(`Already at ${url}, but forced refresh requested. Reloading page...`);
      
      // Capture before refresh
      await takeScreenshot('before_forced_refresh');
      
      // Reload the page
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
      
      logger.info(`Page ${url} reloaded correctly by forced request.`);
      
      // Capture after refresh
      await takeScreenshot('after_forced_refresh');
      
      // Wait for page to stabilize
      await delay(2000);
      
      // Apply zoom on reloaded page
      await applyZoom();
      
      // Hide unwanted elements
      await hideUnwantedElements();
      
      return;
    }

    // If not at the URL or forcing refresh, navigate normally
    logger.info(`Navigating to ${url}${forceRefresh ? ' (forced)' : ''}...`);
    
    // Using 'networkidle2' ensures the page is fully loaded
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    logger.info(`Navigation to ${url} complete.`);
    
    // Wait for page to stabilize
    await delay(1000);
    
    // Apply zoom on new page
    await applyZoom();
    
    // Hide unwanted elements
    await hideUnwantedElements();
    
    // Additional pause to allow zoom and hiding to apply completely
    await delay(500);

  } catch (error) {
    logger.error(`Error navigating to ${url}${forceRefresh ? ' (forced)' : ''}: ${error.message}`);
    // Don't log full stack trace for common navigation timeouts
    if (!error.message.includes('timeout')) {
       logger.error(error.stack);
    }
    
    // Capture screen in case of error
    await takeScreenshot('navigation_error');
    
    throw error; // Rethrow for Orchestrator to handle failure
  }
} // End navigateTo

/**
 * Method to reinforce zoom at any time.
 * Can be called by other modules if zoom is detected to be incorrect.
 */
async function forceZoom() {
  logger.info(`Forcing zoom application to ${ZOOM_LEVEL}...`);
  return await applyZoom();
}

/**
 * Changes the zoom level (for advanced use only)
 * @param {string} newZoomLevel - New zoom level (e.g., '30%', '50%', etc.)
 */
async function setZoomLevel(newZoomLevel) {
    // Validate format
    if (!/^\d+%$/.test(newZoomLevel)) {
        logger.error(`Invalid zoom format: ${newZoomLevel}. Should be like '30%'`);
        return false;
    }
    
    try {
        // Apply script with new level
        const result = await page.evaluate(getZoomInjectionScript(newZoomLevel));
        
        if (result === "ZOOM_APPLIED") {
            logger.info(`Zoom updated to ${newZoomLevel} using definitive solution.`);
            return true;
        } else {
            logger.warn(`Unexpected response when updating zoom: ${result}`);
            return false;
        }
    } catch (error) {
        logger.error(`Error updating zoom: ${error.message}`);
        return false;
    }
}

/**
 * Safely closes the browser instance.
 */
async function closeBrowser() {
  // Check if there's an active browser instance
  if (browser) {
    try {
      logger.info('Closing the browser...');
      await browser.close(); // Close the browser
      logger.info('Browser closed correctly.');
    } catch (error) {
      logger.error(`Error closing browser: ${error.message}`);
      // We could try to force close if it fails, but it's risky
    } finally {
      // Clean up global variables regardless of outcome
      browser = null;
      page = null;
    }
  } else {
    // If no browser was started, just log it
    logger.info('Browser was not started, no need to close.');
  }
} // End closeBrowser

/**
 * Returns the current page instance.
 * @returns {import('playwright').Page | null} The page instance or null.
 */
function getPage() {
  return page;
} // End getPage

/**
 * Returns the current browser instance.
 * @returns {import('playwright').Browser | null} The browser instance or null.
 */
function getBrowser() {
  return browser;
} // End getBrowser

/**
 * Reloads the current page.
 * Utility to refresh the current page without changing URL.
 * @returns {Promise<boolean>} True if reloaded correctly, false in case of error.
 */
async function refreshPage() {
  if (!page) {
    logger.error('Page not available for reload.');
    return false;
  }
  
  try {
    logger.info('Reloading current page...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    logger.info('Page reloaded correctly.');
    
    // Wait for page to stabilize
    await delay(1000);
    
    // Re-apply zoom
    await applyZoom();
    
    // Hide unwanted elements after reload
    await hideUnwantedElements();
    
    return true;
  } catch (error) {
    logger.error(`Error reloading page: ${error.message}`);
    return false;
  }
}

// Export public module functions
export { 
    launchBrowser,
    navigateTo, 
    closeBrowser, 
    getPage, 
    getBrowser, 
    forceZoom,
    setZoomLevel,  // Expose function to change zoom dynamically
    refreshPage,   // New function to reload current page
    takeScreenshot, // Function to take screenshots
    hideUnwantedElements // Expose function to manually hide elements if needed
};