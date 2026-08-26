// Non-secret configuration. Safe to commit — the Apps Script deployment URL
// and OAuth client ID are both meant to be public (the security boundary is
// the allow-list check inside Code.gs, not secrecy of these values).
window.PORTAL_CONFIG = {
  // Apps Script Web App deployment URL ("Deploy > New deployment > Web app").
  API_URL: "https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec",

  // OAuth 2.0 Client ID from Google Cloud Console (Web application type).
  GOOGLE_CLIENT_ID: "REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com",

  // Sections live in the MVP. Extend as later phases ship (see README).
  SECTIONS: [
    { id: "hospitals", label: "Hospitals" },
  ],
};
