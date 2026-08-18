import { html, raw } from './html.js';
import { layout, notice } from './layout.js';

export function loginPage({ flash, next = '', username = '' }) {
  const body = html`
    <main class="login-page">
      <div class="container login-grid">
        <div class="stack-6">
          <a class="wordmark" href="/">App<span class="wordmark-run">Runner</span></a>
          <h1 class="login-title">
            Ship the archive.<br>
            <span class="accent">Let the gates decide.</span>
          </h1>
          <p class="lead">
            Upload a Flutter project or pull it from GitHub. A public runner fetches it with your
            key and walks it through three gates in order — each one only opens if the last one passed.
          </p>
          <div class="gate-line">
            <span>flutter test</span>
            <span class="arrow">→</span>
            <span>ios build</span>
            <span class="arrow">→</span>
            <span>firebase xctest</span>
          </div>
        </div>

        <div class="card card-featured login-form">
          ${notice(flash)}
          <div class="stack-2">
            <h2>Sign in</h2>
            <p class="field-help">AppRunner is a single-operator control plane.</p>
          </div>
          <form class="form" method="post" action="/login">
            <input type="hidden" name="next" value="${next}">
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" type="text" autocomplete="username"
                     value="${username}" required autofocus spellcheck="false">
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </div>
            <div class="form-actions">
              <button class="btn btn-accent" type="submit">Sign in</button>
            </div>
          </form>
        </div>
      </div>
    </main>`;

  return layout({ title: 'Sign in', user: null, body, bare: true });
}
