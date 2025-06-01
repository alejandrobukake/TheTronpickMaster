// src/modules/TelegramNotifier.js
//
// Este módulo se encarga de enviar notificaciones a Telegram
// Soporta dos canales: uno para notificaciones del sistema y otro para alertas monetarias

import path from 'path';
import fs from 'fs/promises';
import { getConfig } from './ConfigManager.js';
import logger from '../utils/logger.js';

// Importar node-fetch - necesitarás instalar este paquete: npm install node-fetch
import fetch from 'node-fetch';

// Tipos de eventos del sistema
const SystemEventType = {
    BOT_STARTED: 'BOT_STARTED',                 // Inicio del bot
    CRITICAL_ERROR: 'CRITICAL_ERROR',           // Error crítico
    BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED', // Fallo al iniciar navegador
    CONNECTION_ERROR: 'CONNECTION_ERROR',       // Error de conexión
    BOT_RESTART: 'BOT_RESTART',                 // Reinicio del bot
    EMAIL_CONNECTION_ERROR: 'EMAIL_CONNECTION_ERROR', // Error IMAP
    MAX_ATTEMPTS_EXCEEDED: 'MAX_ATTEMPTS_EXCEEDED', // Límite de intentos superado
    RETRY_SUCCESS: 'RETRY_SUCCESS',             // Superación de errores
    BOT_STOPPED: 'BOT_STOPPED',                 // Bot detenido
    LEVEL_13_LOSS: 'LEVEL_13_LOSS',             // Pérdida en nivel 13
    UNHANDLED_ERROR: 'UNHANDLED_ERROR',          // Error no manejado
    BALANCE_INACTIVITY: 'BALANCE_INACTIVITY',    // Sin cambios en 15 minutos
    WITHDRAWAL_THRESHOLD_REACHED: 'WITHDRAWAL_THRESHOLD_REACHED', // Balance reached withdrawal threshold - manual action needed
    SYSTEM_RESUMED: 'SYSTEM_RESUMED'            // System resumed after manual withdrawal
};

// Tipos de eventos monetarios
const MoneyEventType = {
    WITHDRAWAL_SUCCESS: 'WITHDRAWAL_SUCCESS',   // Retiro exitoso
    BALANCE_CHANGE: 'BALANCE_CHANGE',           // Cambio significativo de balance
    BALANCE_INITIAL: 'BALANCE_INITIAL',         // Balance inicial al inicio
    BALANCE_INACTIVITY: 'BALANCE_INACTIVITY'    // Sin cambios en 15 minutos
};

// Tipos de canales de Telegram
const ChannelType = {
    SYSTEM: 'SYSTEM',  // Canal de notificaciones del sistema
    MONEY: 'MONEY'     // Canal de alertas monetarias
};

// Emojis para usar en los mensajes
const EMOJIS = {
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    INFO: '📢',
    MONEY: '💰',
    ROBOT: '🤖',
    CHART_UP: '📈',
    CHART_DOWN: '📉',
    BANK: '🏦',
    MAIL: '📧',
    TIME: '⏰',
    LEVEL: '🎮',
    LOSS: '💸',
    ROCKET: '🚀',
    FIRE: '🔥',
    VNC: '🖥️',
    PAUSE: '⏸️',
    PLAY: '▶️',
    ALERT: '🚨',
    COMPUTER: '💻',
};

// Configuración para reintentos de envío de mensajes
const MAX_TELEGRAM_RETRIES = 3; // Número máximo de intentos
const RETRY_DELAY_MS = 2000;    // Tiempo entre reintentos (2 segundos)

/**
 * Envía un mensaje a Telegram con reintentos automáticos
 * @param {ChannelType} channelType - Tipo de canal (SYSTEM o MONEY)
 * @param {string} message - Mensaje a enviar
 * @param {boolean} [useHTML=false] - Si true, usa formato HTML en lugar de Markdown
 * @param {number} [retryCount=0] - Contador de reintentos actual (uso interno)
 * @returns {Promise<boolean>} - true si se envió correctamente, false en caso de error
 */
async function sendWithRetry(channelType, message, useHTML = false, retryCount = 0) {
    try {
        const success = await sendTelegramMessage(channelType, message, useHTML);
        if (success) {
            if (retryCount > 0) {
                logger.info(`Telegram: mensaje enviado exitosamente después de ${retryCount + 1} intentos.`);
            }
            return true;
        }
        if (retryCount < MAX_TELEGRAM_RETRIES - 1) {
            logger.warn(`Telegram: intento ${retryCount + 1}/${MAX_TELEGRAM_RETRIES} fallido. Reintentando en ${RETRY_DELAY_MS}ms...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return sendWithRetry(channelType, message, useHTML, retryCount + 1);
        }
        logger.error(`Telegram: mensaje no enviado después de ${MAX_TELEGRAM_RETRIES} intentos.`);
        return false;
    } catch (error) {
        logger.error(`Error inesperado en sendWithRetry (intento ${retryCount + 1}/${MAX_TELEGRAM_RETRIES}): ${error.message}`);
        if (retryCount < MAX_TELEGRAM_RETRIES - 1) {
            logger.warn(`Telegram: reintentando después de error en ${RETRY_DELAY_MS}ms...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return sendWithRetry(channelType, message, useHTML, retryCount + 1);
        }
        return false;
    }
}

/**
 * Envía un mensaje a un canal de Telegram
 * @param {ChannelType} channelType - Tipo de canal (SYSTEM o MONEY)
 * @param {string} message - Mensaje a enviar
 * @param {boolean} [useHTML=false] - Si true, usa formato HTML en lugar de Markdown
 * @returns {Promise<boolean>} - true si se envió correctamente, false en caso de error
 */
async function sendTelegramMessage(channelType, message, useHTML = false) {
    try {
        const config = getConfig();
        const vpsId = config.vpsIdentifier || 'UNKNOWN_VPS';
        
        // Determinar el chat_id según el tipo de canal
        let chatId;
        if (channelType === ChannelType.SYSTEM) {
            chatId = config.telegramSystemChannelId;
        } else if (channelType === ChannelType.MONEY) {
            chatId = config.telegramMoneyChannelId;
        } else {
            throw new Error(`Tipo de canal desconocido: ${channelType}`);
        }
        
        // Verificar que tengamos la configuración necesaria
        if (!config.telegramBotToken || !chatId) {
            logger.warn('Configuración de Telegram incompleta. No se enviará notificación.');
            return false;
        }
        
        // Formatear el ID del VPS en negrita y añadir al inicio del mensaje
        const fullMessage = `*[${vpsId}]* ${message}`;
        
        // URL de la API de Telegram
        const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
        
        // Parámetros de la solicitud
        const params = {
            chat_id: chatId,
            text: fullMessage,
            parse_mode: useHTML ? 'HTML' : 'Markdown',
            disable_notification: false
        };
        
        // Realizar la solicitud HTTP
        let response;
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(params),
                timeout: 10000
            });
        } catch (fetchError) {
            if (fetchError.name === 'AbortError') {
                logger.error(`Telegram: timeout al enviar mensaje a ${channelType}`);
            } else if (fetchError.message.includes('ENOTFOUND')) {
                logger.error(`Telegram: error de resolución DNS al enviar mensaje a ${channelType}`);
            } else if (fetchError.message.includes('ECONNREFUSED')) {
                logger.error(`Telegram: conexión rechazada al enviar mensaje a ${channelType}`);
            } else {
                logger.error(`Telegram: error de red al enviar mensaje a ${channelType}: ${fetchError.message}`);
            }
            return false;
        }
        
        // Verificar la respuesta
        if (response.ok) {
            const responseData = await response.json();
            logger.debug(`Mensaje de Telegram enviado correctamente a canal ${channelType}.`);
            return true;
        } else {
            const statusCode = response.status;
            let errorText;
            try {
                const errorData = await response.json();
                errorText = errorData.description || await response.text();
            } catch {
                errorText = await response.text();
            }
            if (statusCode === 401) {
                logger.error(`Telegram: Token inválido (401). Comprueba el token del bot.`);
            } else if (statusCode === 400) {
                if (errorText.includes('chat not found')) {
                    logger.error(`Telegram: Chat ID no encontrado. Comprueba el ID del canal ${channelType}.`);
                } else if (errorText.includes('message is too long')) {
                    logger.error(`Telegram: El mensaje es demasiado largo para enviarse.`);
                } else {
                    logger.error(`Telegram: Error de solicitud (400): ${errorText}`);
                }
            } else if (statusCode === 429) {
                logger.error(`Telegram: Límite de tasa excedido (429). Demasiadas solicitudes.`);
            } else {
                logger.error(`Telegram: Error de API (${statusCode}): ${errorText}`);
            }
            return false;
        }
    } catch (error) {
        logger.error(`Excepción al enviar mensaje a Telegram: ${error.message}`);
        return false;
    }
}

/**
 * Formatea la hora actual para mensajes
 * @returns {string} Hora formateada (HH:MM:SS)
 */
function getFormattedTime() {
    const now = new Date();
    return now.toLocaleTimeString('es-ES', { hour12: false });
}

/**
 * Formatea la fecha y hora actual para mensajes
 * @returns {string} Fecha y hora formateadas (DD/MM/YYYY HH:MM:SS)
 */
function getFormattedDateTime() {
    const now = new Date();
    return now.toLocaleString('es-ES', { hour12: false });
}

/**
 * Formatea un valor de balance para mostrar
 * @param {number} balance - Valor del balance
 * @returns {string} Balance formateado con 6 decimales
 */
function formatBalance(balance) {
    return typeof balance === 'number' ? balance.toFixed(6) : '0.000000';
}

/**
 * Formatea un valor de PnL con signo y 6 decimales
 * @param {number} pnl - Valor del PnL
 * @returns {string} PnL formateado con signo y 6 decimales
 */
function formatPnL(pnl) {
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}${pnl.toFixed(6)}`;
}

/**
 * Elige el emoji adecuado para un valor de PnL
 * @param {number} pnl - Valor del PnL
 * @returns {string} Emoji correspondiente
 */
function getPnLEmoji(pnl) {
    return pnl >= 0 ? EMOJIS.CHART_UP : EMOJIS.CHART_DOWN;
}

/**
 * Envía una notificación de evento del sistema
 * @param {SystemEventType} eventType - Tipo de evento del sistema
 * @param {object} [details={}] - Detalles adicionales del evento
 * @returns {Promise<boolean>} - Resultado del envío
 */
async function notifySystemEvent(eventType, details = {}) {
    try {
        let message = '';
        const time = getFormattedDateTime();
        
        switch(eventType) {
            case SystemEventType.BOT_STARTED:
                message = `${EMOJIS.ROBOT} ${EMOJIS.SUCCESS} *BOT INICIADO* - ${time}\n\n`;
                message += `Email: \`${details.email || 'N/A'}\`\n`;
                message += `Dirección de retiro: \`${details.withdrawalAddress || 'N/A'}\``;
                break;
                
            case SystemEventType.CRITICAL_ERROR:
                message = `${EMOJIS.ERROR} *ERROR CRÍTICO* - ${time}\n\n`;
                message += `Mensaje: \`${details.message || 'Error desconocido'}\``;
                break;
                
            case SystemEventType.BROWSER_LAUNCH_FAILED:
                message = `${EMOJIS.ERROR} *FALLO AL INICIAR NAVEGADOR* - ${time}\n\n`;
                message += `Mensaje: \`${details.message || 'Error desconocido'}\``;
                break;
                
            case SystemEventType.CONNECTION_ERROR:
                message = `${EMOJIS.WARNING} *ERROR DE CONEXIÓN* - ${time}\n\n`;
                message += `URL: \`${details.url || 'N/A'}\`\n`;
                message += `Mensaje: \`${details.message || 'Error desconocido'}\``;
                break;
                
            case SystemEventType.BOT_RESTART:
                message = `${EMOJIS.INFO} *BOT REINICIADO* - ${time}\n\n`;
                message += `Motivo: \`${details.reason || 'Desconocido'}\``;
                break;
                
            case SystemEventType.EMAIL_CONNECTION_ERROR:
                message = `${EMOJIS.MAIL} ${EMOJIS.ERROR} *ERROR DE CONEXIÓN EMAIL* - ${time}\n\n`;
                message += `Servidor: \`${details.server || 'N/A'}\`\n`;
                message += `Mensaje: \`${details.message || 'Error desconocido'}\``;
                break;
                
            case SystemEventType.MAX_ATTEMPTS_EXCEEDED:
                message = `${EMOJIS.WARNING} *LÍMITE DE INTENTOS SUPERADO* - ${time}\n\n`;
                message += `Operación: \`${details.operation || 'Desconocida'}\`\n`;
                message += `Intentos: \`${details.attempts || 'N/A'}\``;
                break;
                
            case SystemEventType.RETRY_SUCCESS:
                message = `${EMOJIS.SUCCESS} *ERRORES SUPERADOS* - ${time}\n\n`;
                message += `Operación: \`${details.operation || 'Desconocida'}\`\n`;
                message += `Intentos: \`${details.attempts || 'N/A'}\``;
                break;
                
            case SystemEventType.BOT_STOPPED:
                message = `${EMOJIS.INFO} *BOT DETENIDO* - ${time}\n\n`;
                message += `Motivo: \`${details.reason || 'Desconocido'}\``;
                break;
                
            case SystemEventType.LEVEL_13_LOSS:
                message = `${EMOJIS.LEVEL} ${EMOJIS.LOSS} *PÉRDIDA EN NIVEL 13* - ${time}\n\n`;
                message += `PnL Total: \`${formatPnL(details.pnl || 0)}\``;
                break;
                
            case SystemEventType.UNHANDLED_ERROR:
                message = `${EMOJIS.ERROR} *ERROR NO MANEJADO* - ${time}\n\n`;
                message += `Estado: \`${details.state || 'Desconocido'}\`\n`;
                message += `Mensaje: \`${details.message || 'Error desconocido'}\``;
                break;
                
            case SystemEventType.BALANCE_INACTIVITY:
                message = `${EMOJIS.TIME} *NO BALANCE CHANGES* - ${time}\n\n`;
                message += `Current balance: \`${formatBalance(details.balance || 0)} TRX\`\n`;
                message += `Last change: \`${details.lastChangeTime || 'N/A'}\`\n`;
                message += `Inactive minutes: \`${details.inactiveMinutes || 0}\``;
                break;

            case SystemEventType.WITHDRAWAL_THRESHOLD_REACHED:
                message = `${EMOJIS.ALERT} ${EMOJIS.VNC} *WITHDRAWAL THRESHOLD REACHED* - ${time}\n\n`;
                message += `Current balance: \`${formatBalance(details.balance || 0)} TRX\`\n`;
                message += `Threshold: \`${formatBalance(details.threshold || 0)} TRX\`\n\n`;
                message += `${EMOJIS.COMPUTER} **VNC CONNECTION INFO:**\n`;
                message += `IP: \`${details.serverIP || 'UNKNOWN_IP'}\`\n`;
                message += `Port: \`${details.vncPort || 5901}\`\n`;
                message += `Password: \`${details.vncPassword || '383360'}\`\n\n`;
                message += `${EMOJIS.WARNING} **ROULETTE PAUSED** - Only faucet claims will continue\n`;
                message += `Connect via VNC to perform manual withdrawal`;
                break;

            case SystemEventType.SYSTEM_RESUMED:
                message = `${EMOJIS.PLAY} ${EMOJIS.SUCCESS} *SYSTEM RESUMED* - ${time}\n\n`;
                message += `Current balance: \`${formatBalance(details.balance || 0)} TRX\`\n`;
                message += `${details.message || 'System has resumed normal operation'}\n\n`;
                message += `${EMOJIS.ROCKET} Roulette gameplay restarted automatically`;
                break;

            default:
                message = `${EMOJIS.INFO} *EVENTO DEL SISTEMA* - ${time}\n\n`;
                message += `Tipo: \`${eventType}\`\n`;
                message += `Detalles: \`${JSON.stringify(details)}\``;
        }
        
        return await sendWithRetry(ChannelType.SYSTEM, message);
    } catch (error) {
        logger.error(`Error al notificar evento del sistema: ${error.message}`);
        return false;
    }
}

/**
 * Envía una notificación de evento monetario
 * @param {MoneyEventType} eventType - Tipo de evento monetario
 * @param {object} details - Detalles del evento
 * @returns {Promise<boolean>} - Resultado del envío
 */
async function notifyMoneyEvent(eventType, details = {}) {
    try {
        let message = '';
        const time = getFormattedDateTime();
        
        switch(eventType) {
            case MoneyEventType.WITHDRAWAL_SUCCESS:
                message = `${EMOJIS.MONEY} ${EMOJIS.SUCCESS} *WITHDRAWAL SUCCESS* - ${time}\n\n`;
                message += `Amount: \`${formatBalance(details.amount || 0)} TRX\`\n`;
                message += `New balance: \`${formatBalance(details.newBalance || 0)} TRX\`\n`;
                message += `Address: \`${details.address || 'N/A'}\``;
                break;
                
            case MoneyEventType.BALANCE_CHANGE:
                const pnl = details.pnl || (details.currentBalance - details.previousBalance) || 0;
                const pnlEmoji = getPnLEmoji(pnl);
                const changePercent = Math.abs(pnl / details.previousBalance) * 100;
                
                message = `${EMOJIS.BANK} ${pnlEmoji} *BALANCE CHANGE* - ${time}\n\n`;
                message += `Current balance: \`${formatBalance(details.currentBalance || 0)} TRX\`\n`;
                message += `Previous balance: \`${formatBalance(details.previousBalance || 0)} TRX\`\n`;
                message += `PnL: \`${formatPnL(pnl)} TRX\` (${changePercent.toFixed(4)}%)`;
                break;
                
            case MoneyEventType.BALANCE_INITIAL:
                message = `${EMOJIS.MONEY} ${EMOJIS.INFO} *INITIAL BALANCE* - ${time}\n\n`;
                message += `Initial balance: \`${formatBalance(details.balance || 0)} TRX\`\n`;
                message += `This is the starting point for monitoring changes ≥0.2%.`;
                break;
                
            case MoneyEventType.BALANCE_INACTIVITY:
                message = `${EMOJIS.TIME} *NO BALANCE CHANGES* - ${time}\n\n`;
                message += `Current balance: \`${formatBalance(details.balance || 0)} TRX\`\n`;
                message += `Last change: \`${details.lastChangeTime || 'N/A'}\`\n`;
                message += `Inactive minutes: \`${details.inactiveMinutes || 0}\``;
                break;
                
            default:
                message = `${EMOJIS.MONEY} *MONETARY EVENT* - ${time}\n\n`;
                message += `Type: \`${eventType}\`\n`;
                message += `Details: \`${JSON.stringify(details)}\``;
        }
        
        return await sendWithRetry(ChannelType.MONEY, message);
    } catch (error) {
        logger.error(`Error notificando evento monetario: ${error.message}`);
        return false;
    }
}

/**
 * Verifica si la configuración de Telegram está completa
 * @returns {boolean} - true si la configuración está completa
 */
function isTelegramConfigured() {
    try {
        const config = getConfig();
        const hasToken = !!config.telegramBotToken;
        const hasSystemChannel = !!config.telegramSystemChannelId;
        const hasMoneyChannel = !!config.telegramMoneyChannelId;
        const hasVpsId = !!config.vpsIdentifier;
        const isConfigured = hasToken && hasSystemChannel && hasMoneyChannel && hasVpsId;
        if (!isConfigured) {
            logger.debug("Configuración de Telegram incompleta:");
            if (!hasToken) logger.debug("- Falta token del bot");
            if (!hasSystemChannel) logger.debug("- Falta ID del canal de sistema");
            if (!hasMoneyChannel) logger.debug("- Falta ID del canal de dinero");
            if (!hasVpsId) logger.debug("- Falta identificador de VPS");
        }
        return isConfigured;
    } catch (error) {
        logger.error(`Error al verificar configuración de Telegram: ${error.message}`);
        return false;
    }
}

// Exportar funciones y constantes
export {
    sendTelegramMessage,
    sendWithRetry,
    notifySystemEvent,
    notifyMoneyEvent,
    isTelegramConfigured,
    SystemEventType,
    MoneyEventType,
    ChannelType
};