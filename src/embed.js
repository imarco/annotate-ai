import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import { Picker } from 'emoji-picker-element';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';

const script = document.currentScript;
const key = script?.dataset.key;
const base = new URL('.', script?.src || location.href);

if (!key) {
  console.error('annotate-ai: data-key is required');
} else {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('embed.css', base).href;
  document.head.appendChild(css);

  window.AnnotateConfig = {
    ...window.AnnotateConfig,
    position: script.dataset.position || window.AnnotateConfig?.position,
    accent: script.dataset.accent || window.AnnotateConfig?.accent,
    key,
    apiBase: base.href.replace(/\/$/, ''),
    project: key,
  };

  window.AnnotateVendor = {
    markdown(value) {
      return DOMPurify.sanitize(marked.parse(value || ''), { FORBID_TAGS: ['img'] });
    },
    addEmojiButton(textarea, parent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'an-mini';
      button.textContent = '😀 Emoji';
      button.setAttribute('aria-label', 'Choose emoji');
      button.setAttribute('aria-expanded', 'false');
      parent.appendChild(button);
      let pop;
      const close = () => {
        pop?.remove();
        pop = null;
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', closeOutside, true);
      };
      const closeOutside = event => {
        if (!pop?.contains(event.target) && !button.contains(event.target)) close();
      };
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (pop) { close(); return; }
        document.querySelector('.an-emoji-pop')?.dispatchEvent(new Event('an-close'));
        pop = document.createElement('div');
        pop.className = 'an-emoji-pop';
        pop.addEventListener('an-close', close);
        const picker = new Picker({ dataSource: new URL('emoji-data.json', base).href });
        picker.addEventListener('emoji-click', choice => {
          const start = textarea.selectionStart;
          textarea.setRangeText(choice.detail.unicode, start, textarea.selectionEnd, 'end');
          textarea.focus();
          close();
        });
        pop.appendChild(picker);
        document.body.appendChild(pop);
        const anchor = button.getBoundingClientRect();
        const box = pop.getBoundingClientRect();
        const gap = 8;
        const below = innerHeight - anchor.bottom - gap;
        const above = anchor.top - gap;
        pop.style.left = `${Math.max(gap, Math.min(anchor.right - box.width, innerWidth - box.width - gap))}px`;
        pop.style.top = `${Math.max(gap, Math.min(
          below >= box.height || below >= above ? anchor.bottom + gap : anchor.top - box.height - gap,
          innerHeight - box.height - gap,
        ))}px`;
        button.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', closeOutside, true);
      });
      return button;
    },
    pickImage(onFile) {
      const uppy = new Uppy({
        restrictions: { maxFileSize: 5 * 1024 * 1024, maxNumberOfFiles: 1,
          allowedFileTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
      });
      uppy.use(Dashboard, { target: document.body, inline: false, hideUploadButton: true,
        note: 'JPEG, PNG, WebP or GIF · up to 5 MB' });
      const dashboard = uppy.getPlugin('Dashboard');
      uppy.on('file-added', async file => {
        dashboard.closeModal();
        try { await onFile(file.data); } finally { uppy.destroy(); }
      });
      uppy.on('dashboard:modal-closed', () => {
        if (!uppy.getFiles().length) uppy.destroy();
      });
      dashboard.openModal();
    },
  };

  const runtime = document.createElement('script');
  runtime.src = new URL('annotate.js', base).href + new URL(script.src).search;
  runtime.defer = true;
  document.head.appendChild(runtime);
}
