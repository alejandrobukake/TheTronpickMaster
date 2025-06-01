// index.js - Punto de entrada de la aplicación (Import estándar)

// Log #1: Inicio
console.log("[INDEX] Iniciando ejecución de index.js...");

// Importar al principio
import { start } from './Orchestrator.js';  // Sin src/
console.log("[INDEX] Importación de Orchestrator completada (estándar).");

// Envolver la llamada a start en un bloque try...catch
try {
    // Log #2: Intentando llamar a start()
    console.log("[INDEX] Llamando a Orchestrator.start()...");

    // Llamar a start y manejar errores si la promesa es rechazada
    start().catch(startError => {
        console.error("[INDEX] ¡ERROR ASÍNCRONO DURANTE LA EJECUCIÓN DE start()!", startError);
        console.error(startError.stack);
        // Intentar cierre de emergencia
        import('./src/modules/BrowserManager.js')
            .then(({ closeBrowser }) => closeBrowser())
            .catch(closeErr => console.error("[INDEX] Error adicional intentando cerrar navegador:", closeErr))
            .finally(() => process.exit(1));
    });

    console.log("[INDEX] Llamada a start() iniciada (asíncrona). El script debería continuar...");

} catch (syncError) {
    // Log #3: Error síncrono (poco probable con import al principio)
    console.error("[INDEX] ¡ERROR SÍNCRONO INESPERADO!", syncError);
    console.error(syncError.stack);
    process.exit(1);
}

console.log("[INDEX] Fin del script síncrono de index.js.");
