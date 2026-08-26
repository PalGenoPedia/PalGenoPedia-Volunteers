// Non-secret configuration. Safe to commit — the Apps Script deployment URL
// and OAuth client ID are both meant to be public (the security boundary is
// the allow-list check inside Code.gs, not secrecy of these values).
window.PORTAL_CONFIG = {
  // Apps Script Web App deployment URL ("Deploy > New deployment > Web app").
  API_URL: "https://script.google.com/macros/s/AKfycbyRV3tYYe4qV9a2ULISPQ-5FcJRcNvbNTFuhJSH1tJb0QFxVHff3Dj-5B46Zz_JQiQFhA/exec",

  // OAuth 2.0 Client ID from Google Cloud Console (Web application type).
  GOOGLE_CLIENT_ID: "1017482285870-q0dl90l30asn736kad0u7qbucopj209a.apps.googleusercontent.com",

  SECTIONS: [
    { id: "hospitals", label: "Hospitals" },
    { id: "universities", label: "Universities" },
    { id: "schools", label: "Schools" },
    { id: "religious-sites", label: "Religious Sites" },
  ],
};
