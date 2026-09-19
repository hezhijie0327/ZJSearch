<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" version="5" encoding="UTF-8" indent="yes" />
  <xsl:template match="rss">
    <xsl:variable name="instance" select="channel/instance_name" />
    <xsl:variable name="q">
      <xsl:choose>
        <xsl:when test="contains(channel/title, 'search: ')">
          <xsl:value-of select="substring-after(channel/title, 'search: ')" />
        </xsl:when>
        <xsl:otherwise>
          <xsl:value-of select="channel/title" />
        </xsl:otherwise>
      </xsl:choose>
    </xsl:variable>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <title><xsl:value-of select="$q" /> - <xsl:value-of select="$instance" /> RSS Feed</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style>
          :root {
            --bg: #faf9f6; --surface: #ffffff; --surface-2: #f1efe8;
            --line: #e6e2d7; --ink: #201d17; --ink-2: #6b675c; --ink-3: #716c61;
            --accent: #8c6800; --accent-strong: #f5c84c; color-scheme: light;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --bg: #1b1a18; --surface: #232120; --surface-2: #2c2a27;
              --line: #38342f; --ink: #eceae4; --ink-2: #a8a399; --ink-3: #9b958a;
              --accent: #fec843; --accent-strong: #fec843; color-scheme: dark;
            }
          }
          * { box-sizing: border-box; }
          body {
            font-family: system-ui, -apple-system, sans-serif;
            margin: 0 auto; max-width: 48rem; padding: 0 1rem 3rem;
            color: var(--ink); background: var(--bg);
            overflow-wrap: anywhere; /* torrent titles are long dot-joined strings */
          }
          .brand {
            padding: 2rem 0 1.5rem; border-bottom: 2px solid var(--accent-strong);
          }
          .brand .wordmark { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.01em; }
          .brand .wordmark .dot { color: var(--accent); }
          h1 { font-size: 1.25rem; font-weight: 600; margin: 1.4rem 0 0.2rem; }
          .meta { font-size: 0.8rem; color: var(--ink-3); margin-bottom: 1.1rem; }
          .meta .count { font-weight: 600; color: var(--ink-2); }
          article {
            background: var(--surface); border: 1px solid var(--line);
            border-radius: 16px; padding: 0.9rem 1rem; margin-bottom: 0.7rem;
            transition: border-color 0.15s ease;
          }
          article:hover { border-color: var(--accent-strong); }
          .host {
            font-size: 0.75rem; color: var(--ink-3); margin-bottom: 0.25rem;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }
          h3 { margin: 0 0 0.35rem; font-size: 1rem; font-weight: 500; line-height: 1.35; }
          h3 a { color: var(--ink); text-decoration: none; }
          h3 a:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
          p {
            margin: 0 0 0.45rem; font-size: 0.85rem; line-height: 1.5; color: var(--ink-2);
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
          }
          time {
            display: inline-flex; align-items: center; gap: 0.3rem;
            font-size: 0.75rem; color: var(--ink-3);
          }
          time svg { width: 11px; height: 11px; }
          footer {
            margin-top: 1.5rem; text-align: center;
            font-size: 0.75rem; color: var(--ink-3);
          }
          footer a { color: var(--ink-3); }
        </style>
      </head>
      <body>
        <header>
          <div class="brand">
            <span class="wordmark"><xsl:value-of select="$instance" /><span class="dot">.</span></span>
          </div>
          <h1><xsl:value-of select="$q" /></h1>
          <p class="meta">
            <span class="count"><xsl:value-of select="count(channel/item)" /></span>
            <xsl:text> results · RSS</xsl:text>
          </p>
        </header>
        <main>
          <xsl:for-each select="channel/item">
            <article>
              <xsl:variable name="link" select="link" />
              <xsl:variable name="after" select="substring-after($link, '://')" />
              <div class="host">
                <xsl:choose>
                  <xsl:when test="$after != ''">
                    <xsl:value-of select="substring-before($after, '/')" />
                  </xsl:when>
                  <xsl:otherwise>
                    <xsl:value-of select="$link" />
                  </xsl:otherwise>
                </xsl:choose>
              </div>
              <h3>
                <a hreflang="en" target="_blank" rel="noreferrer">
                  <xsl:attribute name="href"><xsl:value-of select="$link" /></xsl:attribute>
                  <xsl:value-of select="title" />
                </a>
              </h3>
              <xsl:if test="description != ''">
                <p><xsl:value-of select="description" /></p>
              </xsl:if>
              <xsl:if test="pubDate != ''">
                <time>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <xsl:value-of select="pubDate" />
                </time>
              </xsl:if>
            </article>
          </xsl:for-each>
        </main>
        <footer>© <span id="year"></span> <xsl:value-of select="$instance" /></footer>
        <script>
          document.getElementById("year").textContent = new Date().getFullYear();
        </script>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
