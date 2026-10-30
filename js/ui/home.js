/** Landing screen: brand promise plus the two primary actions. */

import { el } from "./common.js";

/**
 * @param {{ onSend: () => void, onReceive: () => void }} handlers
 */
export function mountHome({ onSend, onReceive }) {
  const element = el(`
    <section class="screen" aria-labelledby="home-title">
      <div class="home">
        <div class="home__intro">
          <span class="eyebrow">
            <span class="status-dot status-dot--live" aria-hidden="true"></span>
            Peer-to-peer file transfer
          </span>

          <h1 class="hero__title" id="home-title">Move files. <br /><em>Not limits.</em></h1>

          <p class="hero__sub">
            Send a file straight from this browser to another device. Pair with a six-character
            code, then the data streams across an encrypted peer-to-peer channel.
          </p>

          <p class="hero__privacy">
            <i data-icon="shield-check" data-size="16"></i>
            Your files are never uploaded to Droply storage.
          </p>
        </div>

        <div class="home__panel">
          <div class="panel-head">
            <span class="panel-head__label">Start a transfer</span>
            <span class="panel-head__hint">No account needed</span>
          </div>

          <div class="actions" role="group" aria-label="Choose how to start">
            <button type="button" class="action-card action-card--send" data-action="send">
              <span class="action-card__index" aria-hidden="true">01</span>
              <span class="action-card__icon"><i data-icon="upload" data-size="19"></i></span>
              <span class="action-card__body">
                <span class="action-card__title">Send</span>
                <span class="action-card__desc">Pick files and share a one-time code.</span>
              </span>
              <span class="action-card__go"><i data-icon="chevron-right" data-size="18"></i></span>
            </button>

            <button type="button" class="action-card action-card--receive" data-action="receive">
              <span class="action-card__index" aria-hidden="true">02</span>
              <span class="action-card__icon"><i data-icon="download" data-size="19"></i></span>
              <span class="action-card__body">
                <span class="action-card__title">Receive</span>
                <span class="action-card__desc">Scan a QR code or type the six characters.</span>
              </span>
              <span class="action-card__go"><i data-icon="chevron-right" data-size="18"></i></span>
            </button>
          </div>
        </div>
      </div>

      <div class="steps-head">
        <h2 class="steps-head__title">Send files without complicated setup</h2>
        <p class="steps-head__note">No account, no upload step, no link to wait on.</p>
      </div>

      <div class="steps">
        <div class="step">
          <span class="step__num">01</span>
          <div class="step__body">
            <h3>Pick your files</h3>
            <p>Any type, one or many. Nothing leaves your device while you wait.</p>
          </div>
        </div>
        <div class="step">
          <span class="step__num">02</span>
          <div class="step__body">
            <h3>Share the code</h3>
            <p>A six-character code and a QR code pair the two devices for one transfer.</p>
          </div>
        </div>
        <div class="step">
          <span class="step__num">03</span>
          <div class="step__body">
            <h3>Transfer direct</h3>
            <p>Files cross an encrypted WebRTC channel, then the room closes for good.</p>
          </div>
        </div>
      </div>

      <section class="about" aria-labelledby="about-title">
        <div class="about__lead">
          <h2 id="about-title">Direct device-to-device transfer, explained</h2>
          <p>
            Most file-sharing services write your file to a server, hand you a download link and
            keep a copy. Droply skips the middle: the two browsers open an encrypted WebRTC data
            channel, and the file chunks travel straight across it — this browser to that one.
          </p>
        </div>

        <div class="about__grid">
          <article class="about__item">
            <h3>Peer-to-peer file transfer</h3>
            <p>
              A lightweight signaling service introduces the two devices by exchanging a session
              description and ICE candidates. After that it steps aside: it never receives file
              names, sizes or contents.
            </p>
          </article>

          <article class="about__item">
            <h3>Privacy-focused file sharing</h3>
            <p>
              A room is one-time and holds exactly one sender and one receiver. The receiver sees
              the file list and must accept before a single byte moves. Codes expire after ten
              minutes, and nothing is kept afterwards.
            </p>
          </article>

          <article class="about__item">
            <h3>Open source, built in the open</h3>
            <p>
              Droply is an MIT-licensed project by Eagox Studio. The frontend, the signaling Worker
              and the transfer engine are all public, so you can read exactly what runs in your
              browser in the
              <a
                href="https://github.com/Alshahriar-07/Droply"
                target="_blank"
                rel="noopener noreferrer"
                >Droply repository</a
              >.
            </p>
          </article>
        </div>
      </section>
    </section>
  `);

  element.querySelector('[data-action="send"]').addEventListener("click", onSend);
  element.querySelector('[data-action="receive"]').addEventListener("click", onReceive);

  return { element, title: "Send or receive files" };
}
