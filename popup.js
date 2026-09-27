let pollInterval = null;
let currentTabUrl = '';
let isBulkDownloading = false;

const YT_ID_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;

function extractYouTubeId(url) {
  if (!url) return null;
  const match = url.match(YT_ID_REGEX);
  return match ? match[1] : null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const loading = document.getElementById('loading');
  const videoList = document.getElementById('videoList');
  const bulkBar = document.getElementById('bulkBar');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const bulkQualitySelect = document.getElementById('bulkQualitySelect');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    if (loading) loading.textContent = 'לא זוהה דף פעיל.';
    return;
  }
  currentTabUrl = tab.url;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForVideos
    });

    if (loading) loading.style.display = 'none';

    let videos = (results && results[0] && results[0].result) ? results[0].result : [];

    if (videos.length === 0 && tab.url) {
      if (tab.url.includes('youtube.com/watch') || tab.url.includes('youtu.be/') || tab.url.includes('vimeo.com/')) {
        let videoId = extractYouTubeId(tab.url);
        videos.push({
          url: tab.url,
          title: tab.title ? tab.title.replace(/\s*-\s*YouTube$/, '') : 'סרטון ללא שם',
          thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''
        });
      }
    }

    if (videos.length === 0) {
      videoList.innerHTML = '<div style="text-align:center;padding:15px;font-size:12px;">לא נמצאו סרטונים בדף זה.</div>';
      return;
    }

    videoList.innerHTML = '';
    if (bulkBar) bulkBar.style.display = 'flex';
    
    videos.forEach(video => {
      const card = createVideoCard(video);
      videoList.appendChild(card);

      if (video.url.includes('vimeo.com') && !video.thumbnail) {
        fetchVimeoDetails(video.url, card);
      }
    });

    checkAllProgress();

    if (downloadAllBtn && bulkQualitySelect) {
      downloadAllBtn.addEventListener('click', async () => {
        const selectedQuality = bulkQualitySelect.value;
        const cards = Array.from(document.querySelectorAll('.video-card'));

        isBulkDownloading = true;
        downloadAllBtn.disabled = true;
        bulkQualitySelect.disabled = true;
        startPolling();

        for (const card of cards) {
          const url = card.dataset.url;

          if (card.dataset.status === 'finished') {
            continue;
          }

          const started = await triggerDownload(card, selectedQuality);
          if (!started) {
            markCardError(card, 'שגיאה בהפעלת הורדה');
            continue;
          }

          const downloadOutcome = await waitForDownload(url, 30 * 60 * 1000);
          if (downloadOutcome === 'timeout') {
            markCardError(card, 'זמן ההמתנה אזל (Timeout)');
          }

          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        isBulkDownloading = false;
        downloadAllBtn.disabled = false;
        bulkQualitySelect.disabled = false;
        checkAllProgress();
      });
    }
    
  } catch (err) {
    if (loading) {
      loading.style.display = 'block';
      loading.textContent = 'שגיאה בסריקה: ' + err.message;
    }
  }
});

window.addEventListener('unload', () => {
  stopPolling();
});

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(checkAllProgress, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * ממתין עד שהכרטיס של הסרטון יקבל סטטוס finished או error.
 * מסתמך על ה-polling המרכזי היחיד כדי למנוע הצפת קריאות לשרת.
 */
async function waitForDownload(url, timeoutMs = 1800000) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(timer);
        resolve('timeout');
        return;
      }

      const card = document.querySelector(`.video-card[data-url="${CSS.escape(url)}"]`);
      const status = card ? card.dataset.status : null;

      if (status === 'finished' || status === 'error') {
        clearInterval(timer);
        resolve(status);
      }
    }, 500);
  });
}

function markCardError(cardElement, message) {
  cardElement.dataset.status = 'error';
  const pct = cardElement.querySelector('.pct');
  const speed = cardElement.querySelector('.speed');
  const dlBtn = cardElement.querySelector('.dl-btn');
  const select = cardElement.querySelector('.quality-select');
  const progressBox = cardElement.querySelector('.progress-box');

  if (progressBox) progressBox.style.display = 'block';
  if (pct) pct.textContent = 'שגיאה';
  if (speed) speed.textContent = message || 'שגיאת הורדה / חסימת אתר';
  if (dlBtn) {
    dlBtn.disabled = false;
    dlBtn.textContent = 'נסה שוב';
  }
  if (select) select.disabled = false;
}

async function triggerDownload(cardElement, formatId) {
  const dlBtn = cardElement.querySelector('.dl-btn');
  const select = cardElement.querySelector('.quality-select');
  const progressBox = cardElement.querySelector('.progress-box');
  const url = cardElement.dataset.url;

  cardElement.dataset.status = 'downloading';

  if (dlBtn) {
    dlBtn.disabled = true;
    dlBtn.textContent = 'מוריד...';
  }
  if (select) select.disabled = true;
  if (progressBox) progressBox.style.display = 'block';

  try {
    const res = await fetch('http://127.0.0.1:5000/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        format_id: formatId,
        referer: currentTabUrl
      })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data.status === 'started') {
      return true;
    }
    throw new Error('Server rejected download');
  } catch (e) {
    markCardError(cardElement, 'שגיאת התחלת הורדה');
    return false;
  }
}

async function fetchVimeoDetails(vimeoUrl, cardElement) {
  const thumbBox = cardElement.querySelector('.thumb-container');
  const titleEl = cardElement.querySelector('.video-title');

  try {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(vimeoUrl)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (data.thumbnail_url) {
      thumbBox.innerHTML = '';
      const img = document.createElement('img');
      img.src = data.thumbnail_url;
      img.alt = 'תמונה';
      thumbBox.appendChild(img);
    }

    if (data.title && (!titleEl.textContent || titleEl.textContent.startsWith('סרטון #') || titleEl.textContent.startsWith('סרטון מוטמע'))) {
      titleEl.textContent = data.title;
      titleEl.title = data.title;
    }
  } catch (e) {
    if (!thumbBox.querySelector('img')) {
      thumbBox.textContent = 'VIMEO';
      thumbBox.style.color = '#00adef';
      thumbBox.style.lineHeight = '56px';
      thumbBox.style.fontSize = '12px';
      thumbBox.style.textAlign = 'center';
      thumbBox.style.fontWeight = 'bold';
    }
  }
}

async function fetchFormatsOnDemand(url, selectElement) {
  if (selectElement.dataset.loaded === 'true' || selectElement.dataset.loading === 'true') {
    return;
  }
  selectElement.dataset.loading = 'true';

  const originalText = selectElement.options[0] ? selectElement.options[0].textContent : '';
  selectElement.innerHTML = '<option value="best">טוען פורמטים...</option>';

  try {
    const res = await fetch('http://127.0.0.1:5000/formats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, referer: currentTabUrl })
    });
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (data.formats && data.formats.length > 0) {
      selectElement.dataset.loaded = 'true';
      selectElement.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = 'best';
      defaultOpt.textContent = 'איכות מירבית (מומלץ)';
      selectElement.appendChild(defaultOpt);

      data.formats.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.format_id;
        opt.textContent = f.label;
        selectElement.appendChild(opt);
      });
    } else {
      selectElement.innerHTML = `<option value="best">${originalText}</option>`;
    }
  } catch (e) {
    selectElement.innerHTML = `<option value="best">${originalText}</option>`;
  } finally {
    selectElement.dataset.loading = 'false';
  }
}

function scanPageForVideos() {
  const foundVideos = [];
  const seenUrls = new Set();
  const YT_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;

  function findNearbyTitle(element) {
    try {
      const directAttr = element.getAttribute('title') || 
                         element.getAttribute('aria-label') || 
                         element.getAttribute('data-title');
      if (directAttr && directAttr.trim().length > 2) {
        return directAttr.trim();
      }

      let parent = element.parentElement;
      for (let depth = 0; depth < 4 && parent; depth++) {
        const heading = parent.querySelector('h1, h2, h3, h4, h5, .video-title, .title');
        if (heading && heading.textContent && heading.textContent.trim().length > 3) {
          return heading.textContent.trim();
        }

        let prev = element.previousElementSibling;
        while (prev) {
          if (prev && prev.matches && prev.matches('h1, h2, h3, h4, h5, p, div') && prev.textContent.trim().length > 3) {
            return prev.textContent.trim();
          }
          prev = prev.previousElementSibling;
        }

        let next = element.nextElementSibling;
        while (next) {
          if (next && next.matches && next.matches('h1, h2, h3, h4, h5, p, div') && next.textContent.trim().length > 3) {
            return next.textContent.trim();
          }
          next = next.nextElementSibling;
        }

        parent = parent.parentElement;
      }
    } catch (e) {}

    return null;
  }

  try {
    document.querySelectorAll('iframe').forEach((iframe, index) => {
      let src = iframe.src || iframe.getAttribute('data-src') || '';
      if (!src) return;

      let videoUrl = '';
      let thumb = '';
      let title = findNearbyTitle(iframe) || `סרטון #${index + 1}`;

      const match = src.match(YT_REGEX);
      const ytId = match ? match[1] : null;

      if (ytId) {
        videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
        thumb = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
      } else if (src.includes('vimeo.com') || src.includes('player.vimeo.com')) {
        videoUrl = src;
      }

      if (videoUrl && !seenUrls.has(videoUrl)) {
        seenUrls.add(videoUrl);
        foundVideos.push({ url: videoUrl, title: title, thumbnail: thumb });
      }
    });
  } catch (e) {}

  try {
    document.querySelectorAll('video').forEach((v, index) => {
      let src = v.currentSrc || v.src;
      if (!src) {
        const source = v.querySelector('source');
        if (source) src = source.src;
      }
      if (src && !src.startsWith('blob:') && !seenUrls.has(src)) {
        seenUrls.add(src);
        const title = findNearbyTitle(v) || `וידאו ישיר בדף #${index + 1}`;
        foundVideos.push({
          url: src,
          title: title,
          thumbnail: v.poster || ''
        });
      }
    });
  } catch (e) {}

  return foundVideos;
}

function createVideoCard(video) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.url = video.url;
  card.dataset.status = 'idle';

  card.innerHTML = `
    <div class="card-top">
      <div class="thumb-container"></div>
      <div class="card-info">
        <div class="video-title"></div>
      </div>
    </div>
    <div class="card-actions">
      <select class="quality-select">
        <option value="best">איכות מקסימלית (לחץ לבחירת איכות)</option>
        <option value="audio_only">MP3 - אודיו בלבד</option>
      </select>
      <button class="dl-btn">הורד</button>
    </div>
    <div class="progress-box">
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <div class="progress-text">
        <span class="pct">0%</span>
        <span class="speed"></span>
      </div>
    </div>
  `;

  const titleEl = card.querySelector('.video-title');
  titleEl.textContent = video.title;
  titleEl.title = video.title;

  const thumbBox = card.querySelector('.thumb-container');
  if (video.thumbnail) {
    const img = document.createElement('img');
    img.src = video.thumbnail;
    img.alt = 'תמונה';
    thumbBox.appendChild(img);
  } else {
    thumbBox.textContent = 'ללא תמונה';
    thumbBox.style.color = '#aaa';
    thumbBox.style.lineHeight = '56px';
    thumbBox.style.fontSize = '11px';
    thumbBox.style.textAlign = 'center';
  }

  const dlBtn = card.querySelector('.dl-btn');
  const select = card.querySelector('.quality-select');

  select.addEventListener('focus', () => {
    fetchFormatsOnDemand(video.url, select);
  });

  dlBtn.addEventListener('click', async () => {
    const started = await triggerDownload(card, select.value);
    if (started) {
      startPolling();
    }
  });

  return card;
}

function checkAllProgress() {
  fetch('http://127.0.0.1:5000/status')
    .then(res => res.json())
    .then(data => {
      let hasActiveDownloads = false;

      document.querySelectorAll('.video-card').forEach(card => {
        const url = card.dataset.url;
        const statusObj = data[url];
        if (!statusObj) return;

        const fill = card.querySelector('.progress-fill');
        const pct = card.querySelector('.pct');
        const speed = card.querySelector('.speed');
        const dlBtn = card.querySelector('.dl-btn');
        const select = card.querySelector('.quality-select');
        const progressBox = card.querySelector('.progress-box');

        if (progressBox) progressBox.style.display = 'block';

        if (statusObj.status === 'downloading') {
          hasActiveDownloads = true;
          card.dataset.status = 'downloading';
          if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = 'מוריד...'; }
          if (select) select.disabled = true;
          if (fill) fill.style.width = statusObj.percent + '%';
          if (pct) pct.textContent = statusObj.percent + '%';
          if (speed) speed.textContent = `${statusObj.speed} ${statusObj.eta ? '| נותר ' + statusObj.eta : ''}`;
        } else if (statusObj.status === 'finished') {
          card.dataset.status = 'finished';
          if (fill) fill.style.width = '100%';
          if (pct) pct.textContent = '100%';
          if (speed) speed.textContent = 'הושלם בהצלחה!';
          if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = 'הורד שוב'; }
          if (select) select.disabled = false;
        } else if (statusObj.status === 'error') {
          card.dataset.status = 'error';
          if (pct) pct.textContent = 'שגיאה';
          if (speed) speed.textContent = statusObj.error || 'שגיאת הורדה / חסימת אתר';
          if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = 'נסה שוב'; }
          if (select) select.disabled = false;
        }
      });

      if (!hasActiveDownloads && !isBulkDownloading) {
        stopPolling();
      }
    })
    .catch(() => {});
}