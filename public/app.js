/* AppRunner — progressive enhancement only. Every page works without it. */
(function () {
  'use strict';

  // ── Archive picker ────────────────────────────────────────────────────────
  document.querySelectorAll('[data-dropzone]').forEach(function (zone) {
    var input = zone.querySelector('[data-file]');
    var label = zone.querySelector('[data-dropzone-name]');
    if (!input || !label) return;

    function show(files) {
      if (files && files.length) {
        label.textContent = files[0].name;
      }
    }

    input.addEventListener('change', function () { show(input.files); });

    zone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });

    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        zone.classList.add('is-hot');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        zone.classList.remove('is-hot');
      });
    });
    zone.addEventListener('drop', function (event) {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      input.files = event.dataTransfer.files;
      show(input.files);
    });
  });

  // ── Copy a freshly minted CI key ──────────────────────────────────────────
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy');
      var done = function () {
        var original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = original; }, 1600);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(value).then(done, done);
      } else {
        done();
      }
    });
  });

  // ── Live run polling ──────────────────────────────────────────────────────
  var liveHost = document.querySelector('[data-run-live]');
  var compactHost = document.querySelector('[data-run-poll]');
  var runId = liveHost ? liveHost.getAttribute('data-run-live')
            : compactHost ? compactHost.getAttribute('data-run-poll')
            : null;
  if (!runId) return;

  var eventsBox = document.querySelector('[data-events]');
  var lastEventId = 0;
  var failures = 0;

  function renderEvents(events) {
    if (!eventsBox || !events.length) return;
    var placeholder = eventsBox.querySelector('.event .event-msg');
    if (placeholder && placeholder.textContent === 'No progress reported yet.') {
      eventsBox.innerHTML = '';
    }
    events.forEach(function (event) {
      var row = document.createElement('div');
      row.className = 'event event-' + event.level;
      var time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = event.time;
      var msg = document.createElement('span');
      msg.className = 'event-msg';
      msg.textContent = event.message;
      row.appendChild(time);
      row.appendChild(msg);
      eventsBox.appendChild(row);
      lastEventId = Math.max(lastEventId, event.id);
    });
    eventsBox.scrollTop = eventsBox.scrollHeight;
  }

  function replaceRail(host, markup) {
    var rail = host.querySelector('.rail');
    if (!rail || !markup) return;
    var holder = document.createElement('div');
    holder.innerHTML = markup;
    var next = holder.querySelector('.rail');
    if (next) rail.replaceWith(next);
  }

  function poll() {
    fetch('/api/runs/' + encodeURIComponent(runId) + '?since=' + lastEventId, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (data) {
        failures = 0;
        var host = liveHost || compactHost;
        if (host) replaceRail(host, liveHost ? data.railHtml : data.railHtmlCompact);
        renderEvents(data.events || []);
        if (data.done) {
          // Logs and downloads only exist server-side; a reload picks them up.
          window.location.reload();
          return;
        }
        setTimeout(poll, 2500);
      })
      .catch(function () {
        failures += 1;
        if (failures > 8) return;
        setTimeout(poll, Math.min(15000, 2500 * failures));
      });
  }

  if (eventsBox) {
    var existing = eventsBox.querySelectorAll('.event');
    lastEventId = Number(eventsBox.getAttribute('data-last') || 0);
    if (!lastEventId && existing.length) lastEventId = 0;
  }

  setTimeout(poll, 1500);
})();
