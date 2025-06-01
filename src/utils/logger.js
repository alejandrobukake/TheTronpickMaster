// src/utils/logger.js
import winston from 'winston';

// Definir niveles de log personalizados si es necesario (opcional)
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6
};

// Configuración del logger
const logger = winston.createLogger({
  levels: logLevels,
  // Formato del log: timestamp + nivel + mensaje
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), // Añade timestamp
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  // Dónde enviar los logs (Transportes)
  transports: [
    // 1. Enviar logs a la consola
    new winston.transports.Console({
      level: 'info', // Nivel mínimo para mostrar en consola (ajustable)
      format: winston.format.combine(
        winston.format.colorize(), // Añade colores a la salida de consola
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`; // Formato con color
        })
      )
    }),
    // 2. (Opcional más adelante) Enviar logs a un archivo
    // new winston.transports.File({
    //   filename: 'tronpickmaster.log',
    //   level: 'debug' // Nivel mínimo para guardar en archivo (más detallado)
    // })
  ],
  // No salir en caso de error no manejado (opcional, pero recomendado)
  exitOnError: false,
});

// Ejemplo de cómo usarlo (puedes borrar esta línea luego)
// logger.info('Logger inicializado correctamente.');
// logger.warn('Advertencia de prueba.');
// logger.error('Error de prueba.');

// Exportar la instancia del logger para usarla en otros módulos
export default logger;
