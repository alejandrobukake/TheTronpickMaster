    // src/utils/helpers.js

    /**
     * Pausa la ejecución durante un número específico de milisegundos.
     * @param {number} ms - Milisegundos a esperar.
     * @returns {Promise<void>}
     */
    async function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    export { delay };
    
