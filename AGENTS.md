RHR International: AI Agent Rules (AGENTS.md)

This file provides context and instructions for the Antigravity AI Agent. Following these rules ensures that AI-generated code meets RHR Engineering standards for security, reliability, and maintainability.

1. Project Overview & Environment

Environment: Google Apps Script (GAS) running the V8 engine.

Language: JavaScript (ES6+).

Pattern: Use clear function names that correspond to menu items or triggers.

Libraries: Reference the google-apps-script types for autocomplete/linting.

AppSheet Integration: Assume scripts are often triggered by or linked to AppSheet applications.

2. Coding Standards

Function Naming: Use camelCase for all function names (e.g., processVendorData).

Variable Naming: Use camelCase for local variables and UPPER_SNAKE_CASE for global constants.

Error Handling: Every UrlFetchApp.fetch() call must be wrapped in a try...catch block.

Logging: Use console.log() for debugging information. Ensure no PII (Personally Identifiable Information) is logged.

Type JSDoc: Include JSDoc headers for all primary functions to help with IDE autocompletion.

Batch Operations: In SpreadsheetApp, prefer batch operations (getValues() / setValues()) over individual cell access to minimize execution time.

3. Data Hygiene & Security

Security First: Never suggest hardcoding keys. Always prioritize data privacy.

Dummy Data: When generating test cases, always use fake data (e.g., test_user@rhrinternational.com).

Secrets: If the code requires an API key, instruct the user to add it to a Secrets.gs file and add that file to .gitignore.

PII Protection: Never write code that sends raw client data to external 3rd-party APIs without explicit masking or encryption logic.

4. Agent Interaction Style

Concise Explanations: Provide clear, professional explanations of code changes.

Verify Sync: Remind the user to save files to trigger the clasp push watcher if they seem to be testing code that hasn't synced yet.
