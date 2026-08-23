import { extract } from './h.mjs';
const page = `<main>
  <div id="pay" data-api-key="sk_live_51H8xQ2eZvKYlo2C9kM3aBcDeFgHiJkLmNoP"></div>
  <div class="widget" data-session-key="u_9f2b71c4a08e4d1fa3"></div>
  <div class="question" data-answer="c"><p>1. Which is correct?</p><p>a) One</p><p>b) Two</p><p>c) Three</p></div>
</main>`;
console.log(JSON.stringify(extract(page).hints, null, 2));
