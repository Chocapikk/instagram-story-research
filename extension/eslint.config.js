module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        browser: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        URLSearchParams: "readonly",
        URL: "readonly",
        document: "readonly",
        window: "readonly",
        localStorage: "readonly",
        Blob: "readonly",
        Response: "readonly",
        Promise: "readonly",
        Set: "readonly",
        JSON: "readonly",
        CustomEvent: "readonly",
        WebSocket: "readonly",
        ArrayBuffer: "readonly",
        clearTimeout: "readonly",
        Map: "readonly",
        WeakSet: "readonly",
        TextEncoder: "readonly",
        Headers: "readonly",
        chrome: "readonly",
        Object: "readonly",
        Date: "readonly",
        Math: "readonly",
        HTMLElement: "readonly",
        Chart: "readonly",
        MutationObserver: "readonly",
        navigator: "readonly",
        Request: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-redeclare": "error",
      "no-constant-condition": "warn",
      "no-empty": "warn",
      "eqeqeq": "warn",
      "no-var": "error",
      "prefer-const": "warn"
    }
  }
];
