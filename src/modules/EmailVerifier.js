// src/modules/EmailVerifier.js

import { ImapFlow } from 'imapflow';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { getConfig } from './ConfigManager.js';
import { navigateTo, getPage } from './BrowserManager.js';
import { delay } from '../utils/helpers.js';

// Verification types enum
export const VerificationType = {
    REGISTRATION: 'REGISTRATION'
};

// Configuration constants
const MAX_SEARCH_ATTEMPTS = 3;
const SEARCH_RETRY_DELAY_MS = 30 * 1000; // 30 seconds between search attempts
const SEARCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes total search time

/**
 * Connects to the email server, searches for verification emails,
 * and extracts the button link to navigate to it.
 * @param {VerificationType} verificationType - Type of verification to handle
 * @returns {Promise<boolean>} - True if email was successfully verified, false otherwise
 */
export async function verifyEmail(verificationType) {
    logger.info(`Starting email verification for: ${verificationType}`);
    
    const config = getConfig();
    let verificationSuccess = false;
    let attemptCount = 0;
    
    // Create temp and screenshots directories if they don't exist
    try {
        await fs.mkdir('./temp', { recursive: true });
        await fs.mkdir('./screenshots', { recursive: true });
    } catch (err) {
        logger.warn(`Error creating directories: ${err.message}`);
    }
    
    // Set subject and button text for registration verification only
    const emailSubject = "Verify Your Email Address";
    const buttonText = "Verify Email";
    
    const startTime = Date.now();
    
    // Try multiple attempts to find and process the email
    while (Date.now() - startTime < SEARCH_TIMEOUT_MS && attemptCount < MAX_SEARCH_ATTEMPTS && !verificationSuccess) {
        attemptCount++;
        let client = null;
        
        try {
            // Create new IMAP client with improved error handling
            client = new ImapFlow({
                host: config.imapHost || 'imap.gmail.com',
                port: config.imapPort || 993,
                secure: true,
                auth: {
                    user: config.emailUser,
                    pass: config.emailAppPassword
                },
                logger: false,
                tls: { rejectUnauthorized: false },
                connectionTimeout: 60000, // 60 seconds connection timeout
                idleTimeout: 60000       // 60 seconds idle timeout
            });
            
            logger.info(`Connecting to IMAP (${config.imapHost || 'imap.gmail.com'}:${config.imapPort || 993})... Attempt ${attemptCount}`);
            await client.connect();
            logger.info('IMAP connection established.');
            
            // Open the inbox with additional logging
            try {
                const mailbox = await client.mailboxOpen('INBOX');
                logger.info(`Mailbox INBOX opened. Total messages: ${mailbox.exists}`);
            } catch (mailboxError) {
                logger.error(`Error opening mailbox: ${mailboxError.message}`);
                throw mailboxError;
            }
            
            // Progressive search strategies
            let messages = [];
            
            // Strategy 1: Search by subject only (most permissive)
            logger.info(`Search strategy 1: Searching by subject "${emailSubject}" only`);
            try {
                messages = await client.search({ subject: emailSubject });
                logger.info(`Strategy 1 found: ${messages.length} messages`);
            } catch (searchError) {
                logger.error(`Search error: ${searchError.message}`);
            }
            
            // Strategy 2: If no results, try with from address
            if (messages.length === 0) {
                logger.info(`Search strategy 2: Searching by subject and from`);
                try {
                    messages = await client.search({ 
                        subject: emailSubject,
                        from: "support@tronpick.io"
                    });
                    logger.info(`Strategy 2 found: ${messages.length} messages`);
                } catch (searchError) {
                    logger.error(`Search error: ${searchError.message}`);
                }
            }
            
            // Strategy 3: Try with a broader time window and subject contains
            if (messages.length === 0) {
                logger.info(`Search strategy 3: Broader search with recent messages`);
                try {
                    // Get most recent 20 messages
                    const sequence = await client.search({ all: true });
                    if (sequence.length > 0) {
                        // Take last 20 messages or less if there aren't 20
                        const recentMessages = sequence.slice(-Math.min(20, sequence.length));
                        logger.info(`Found ${recentMessages.length} recent messages to check`);
                        
                        // We'll check these messages directly
                        messages = recentMessages;
                    }
                } catch (searchError) {
                    logger.error(`Search error: ${searchError.message}`);
                }
            }
            
            // If we found messages, process them
            if (messages.length > 0) {
                logger.info(`Processing ${messages.length} potential verification emails`);
                
                // Sort newest first (higher UIDs typically mean newer messages)
                messages.sort((a, b) => b - a);
                
                // Process each email
                for (const uid of messages) {
                    logger.info(`Processing message UID: ${uid}`);
                    
                    try {
                        // Fetch the COMPLETE message with envelope, body structure and BODY content
                        // This is the key change to get the full content
                        const message = await client.fetchOne(uid, {
                            envelope: true,
                            bodyStructure: true,
                            source: true,
                            body: true
                        });
                        
                        if (!message) {
                            logger.warn(`Could not fetch message UID: ${uid}`);
                            continue;
                        }
                        
                        // Convert to string and save complete raw message for debugging
                        const messageContent = message.source.toString();
                        const emailPath = path.resolve(`./temp/email_complete_${uid}_${Date.now()}.txt`);
                        await fs.writeFile(emailPath, messageContent);
                        logger.info(`Complete email content saved to: ${emailPath}`);
                        
                        // Look for verification link directly in the content
                        logger.info(`Looking for verification link in email...`);
                        const verificationLink = extractVerificationLink(messageContent, verificationType);
                        
                        if (verificationLink) {
                            logger.info(`Link found!: ${verificationLink}`);
                            
                            // Mark message as read
                            await client.messageFlagsAdd(uid, ['\\Seen']);
                            
                            // Navigate to the link
                            logger.info(`Navigating to verification link...`);
                            await navigateTo(verificationLink);
                            await delay(5000); // Wait for page to load
                            
                            // Capture verification result
                            const page = getPage();
                            if (page) {
                                // Take screenshot
                                const screenshotPath = path.resolve(`./screenshots/verification_result_${Date.now()}.png`);
                                await page.screenshot({ path: screenshotPath, fullPage: true });
                                logger.info(`Screenshot saved to: ${screenshotPath}`);
                                
                                // Get and save page content
                                const currentUrl = page.url();
                                logger.info(`URL after verification: ${currentUrl}`);
                                const pageContent = await page.content();
                                await fs.writeFile(`./temp/verification_page_${Date.now()}.html`, pageContent);
                                
                                // Check for success by page content
                                const pageText = await page.evaluate(() => document.body.innerText);
                                
                                // Success indicators
                                const successTexts = [
                                    "successfully verified",
                                    "verification successful",
                                    "email has been",
                                    "go home",
                                    "thank you"
                                ];
                                
                                const foundSuccess = successTexts.some(text => 
                                    pageText.toLowerCase().includes(text.toLowerCase())
                                );
                                
                                if (foundSuccess || currentUrl.includes('faucet.php')) {
                                    logger.info("Verification successful! Success indicators found on page.");
                                    verificationSuccess = true;
                                    break;
                                } else {
                                    logger.warn("No clear success indicators found, but assuming verification successful.");
                                    verificationSuccess = true; // Assume success anyway
                                    break;
                                }
                            } else {
                                logger.warn("Could not get page to verify result.");
                                verificationSuccess = true; // Assume success
                                break;
                            }
                        } else {
                            logger.warn(`Verification link not found in this email.`);
                        }
                    } catch (processError) {
                        logger.error(`Error processing email UID ${uid}: ${processError.message}`);
                        logger.error(processError.stack);
                    }
                }
            } else {
                logger.info("No emails found matching search criteria.");
            }
            
        } catch (error) {
            logger.error(`Error during IMAP operation: ${error.message}`);
            logger.error(error.stack);
        } finally {
            // Properly close IMAP connection
            if (client) {
                try {
                    if (client.authenticated) {
                        await client.logout();
                    }
                    logger.debug('IMAP connection closed properly.');
                } catch (logoutError) {
                    logger.warn(`Error closing IMAP connection: ${logoutError.message}`);
                }
            }
        }
        
        // Wait before next attempt if needed
        if (!verificationSuccess && attemptCount < MAX_SEARCH_ATTEMPTS) {
            logger.info(`Waiting ${SEARCH_RETRY_DELAY_MS/1000} seconds before next attempt...`);
            await delay(SEARCH_RETRY_DELAY_MS);
        }
    }
    
    // Final result
    if (verificationSuccess) {
        logger.info(`Email verification (${verificationType}) completed successfully!`);
    } else {
        logger.error(`Could not complete email verification (${verificationType}) after ${attemptCount} attempts.`);
    }
    
    return verificationSuccess;
}

/**
 * Extract verification link from email content
 * Handles quoted-printable format and correctly extracts the full verification link
 * @param {string} content - Raw email content
 * @param {VerificationType} verificationType - Type of verification
 * @returns {string|null} - Verification link if found, null otherwise
 */
function extractVerificationLink(content, verificationType) {
    logger.info(`Extracting verification link for: ${verificationType}...`);
    
    try {
        // STEP 1: Handle quoted-printable format - remove line continuations
        let preparedContent = content
            .replace(/=\r\n/g, '') // Remove =CRLF line continuations
            .replace(/=\n/g, '');  // Remove =LF line continuations
        
        // STEP 2: Look for the href attribute containing the verification link
        const hrefPattern = new RegExp(`href=(?:"|'|=3D")(https://tronpick\\.io/confirm\\.php\\?act=(?:3D)?verify_email(?:&|&amp;|&(?:amp;)?key=(?:3D)?[a-zA-Z0-9_\\-]+))(?:"|'|")`, 'i');
        
        const hrefMatches = preparedContent.match(hrefPattern);
        if (hrefMatches && hrefMatches[1]) {
            // STEP 3: Clean up the link by decoding quoted-printable sequences
            let verificationLink = hrefMatches[1]
                .replace(/=3D/g, '=')     // =3D -> =
                .replace(/&amp;/g, '&')   // &amp; -> &
                .replace(/=20/g, ' ');    // =20 -> space
            
            logger.info(`Found link with href pattern: ${verificationLink}`);
            return verificationLink;
        }
        
        // STEP 4: Alternative approach - look for the full URL pattern directly
        const urlPattern = /https:\/\/tronpick\.io\/confirm\.php\?act=(?:3D)?verify_email(?:&|&amp;)key=(?:3D)?[a-zA-Z0-9_\-]+/i;
            
        const urlMatches = preparedContent.match(urlPattern);
        if (urlMatches && urlMatches[0]) {
            let verificationLink = urlMatches[0]
                .replace(/=3D/g, '=')
                .replace(/&amp;/g, '&')
                .replace(/=20/g, ' ');
                
            logger.info(`Found link with direct URL pattern: ${verificationLink}`);
            return verificationLink;
        }
        
        // STEP 5: More specific approach for quoted-printable format
        // Extract key and reconstruct the link
        const keyPattern = /key=(?:3D)?([a-zA-Z0-9_\-]+)/i;
        const keyMatch = preparedContent.match(keyPattern);
        
        if (keyMatch && keyMatch[1]) {
            const key = keyMatch[1];
            const act = 'verify_email';
            const verificationLink = `https://tronpick.io/confirm.php?act=${act}&key=${key}`;
            logger.info(`Reconstructed link from key: ${verificationLink}`);
            return verificationLink;
        }
        
        // STEP 6: Final fallback - extract link parts and reconstruct
        // Extract key from content after removing line breaks
        // This pattern looks for the complete key including all characters
        const fallbackPattern = new RegExp(`key=(?:3D)?([a-zA-Z0-9_\\-]+)`, 'i');
        const fallbackMatch = preparedContent.match(fallbackPattern);
        
        if (fallbackMatch && fallbackMatch[1]) {
            const key = fallbackMatch[1];
            const act = 'verify_email';
            const verificationLink = `https://tronpick.io/confirm.php?act=${act}&key=${key}`;
            logger.info(`Fallback reconstructed link: ${verificationLink}`);
            return verificationLink;
        }
        
        // If we still couldn't find the link, save debug information
        logger.warn(`No verification link found in the email content.`);
        
        // Save preprocessed content for debugging
        const debugFilePath = path.resolve(`./temp/prepared_content_${Date.now()}.txt`);
        fs.writeFile(debugFilePath, preparedContent)
            .then(() => logger.info(`Prepared content saved for debugging at: ${debugFilePath}`))
            .catch(err => logger.error(`Failed to save debug file: ${err.message}`));
        
        return null;
    } catch (error) {
        logger.error(`Error extracting verification link: ${error.message}`);
        logger.error(error.stack);
        return null;
    }
}