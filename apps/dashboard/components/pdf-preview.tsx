'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { Button, Notice } from './ui';

/** Renders the actual PDF without relying on a browser PDF plugin. All assets stay local. */
export function PdfPreview({ data }: { data: ArrayBuffer }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1); const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  const [text, setText] = useState(''); const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof import('pdfjs-dist')['getDocument']> | undefined;
    setPdf(null); setPageNumber(1); setZoom(1); setFailed(false); setLoading(true); setText('');
    void (async () => {
      try {
        const library = await import('pdfjs-dist');
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = `/pdf-assets/${library.version}/pdf.worker.min.mjs`;
        task = library.getDocument({ data: new Uint8Array(data.slice(0)), standardFontDataUrl: `/pdf-assets/${library.version}/standard_fonts/` });
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch {
        if (!cancelled) { setFailed(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; void task?.destroy().catch(() => undefined); };
  }, [data, retry]);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false; let render: RenderTask | undefined;
    const target = canvas.current;
    setLoading(true); setFailed(false); setText('');
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        // Render at a bounded resolution; CSS fits the page to desktop and mobile widths.
        const viewport = page.getViewport({ scale: 1.5 * zoom });
        target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
        render = page.render({ canvas: target, viewport });
        const content = await page.getTextContent();
        await render.promise;
        if (!cancelled) {
          setText(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
          setLoading(false);
        }
      } catch {
        if (!cancelled) { setFailed(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pageNumber, zoom]);

  return <section className="pdf-preview" aria-label={c('Vista previa del PDF', 'PDF preview')} aria-busy={loading}>
    {loading && <p role="status">{c('Cargando la página del PDF…', 'Loading the PDF page…')}</p>}
    {failed && <Notice tone="error" actions={<Button variant="quiet" onClick={() => setRetry(value => value + 1)}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos mostrar el PDF. Puedes reintentarlo o descargarlo para revisarlo.', 'We could not display the PDF. Try again or download it to review it.')}</Notice>}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable so keyboard users can scroll the zoomed page (WCAG 2.1.1) */}
    <div className="pdf-viewport" tabIndex={0} role="region" aria-label={c('Página ampliable del PDF', 'Zoomable PDF page')}><div style={{ width: `${zoom * 100}%` }}><canvas ref={canvas} hidden={loading || failed} role="img" aria-label={c(`Página ${pageNumber} del PDF. El texto está disponible debajo.`, `PDF page ${pageNumber}. The text is available below.`)}/>
    </div></div>
    {pdf && <div className="pdf-zoom"><Button variant="secondary" disabled={loading || zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.25))}>{c('Reducir', 'Zoom out')}</Button><span aria-live="polite">{Math.round(zoom * 100)}%</span><Button variant="secondary" disabled={loading || zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}>{c('Ampliar', 'Zoom in')}</Button><Button variant="quiet" disabled={loading || zoom === 1} onClick={() => setZoom(1)}>{c('Ajustar al ancho', 'Fit to width')}</Button></div>}
    {pdf && <nav className="pdf-controls" aria-label={c('Páginas del PDF', 'PDF pages')}>
      <Button variant="secondary" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}>{c('Anterior', 'Previous')}</Button>
      <span aria-live="polite">{c(`Página ${pageNumber} de ${pdf.numPages}`, `Page ${pageNumber} of ${pdf.numPages}`)}</span>
      <Button variant="secondary" disabled={loading || pageNumber >= pdf.numPages} onClick={() => setPageNumber(value => value + 1)}>{c('Siguiente', 'Next')}</Button>
    </nav>}
    {text && !failed && <details className="pdf-text"><summary>{c('Leer el texto de esta página', 'Read this page’s text')}</summary><p>{text}</p></details>}
  </section>;
}
