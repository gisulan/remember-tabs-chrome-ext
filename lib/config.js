// Shared Microsoft app registration used for OneDrive backup.
// With an ID here, people who install the extension just click "Sign in with Microsoft".
// Nobody else has to register their own app. Each person's backup goes to their own OneDrive.
// The ID is not a secret: it identifies the app, it does not grant access to anything.
// Leave it empty to make everyone register their own app (Setup screen in the panel).
export const SHARED_CLIENT_ID = '';

// 'common' = personal + work/school accounts (must match the app registration's "Supported account types").
export const SHARED_TENANT = 'common';
