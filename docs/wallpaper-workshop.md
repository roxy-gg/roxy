# Wallpaper Workshop

Settings > Background includes a collapsible Workshop below local background controls. Search title/tags, filter images/silent videos, sort Featured/Newest, select a preview, then explicitly Use background. Browsing never automatically applies a wallpaper. Applying fetches approved media through the main process, validates MIME/size/SHA-256, imports it with the existing decoder, and persists a device-local copy. Settings/effects stay unchanged; remove/reset/newer imports supersede pending catalog downloads.

Local upload selection continues saving automatically. Submit for review is a separate optional action, with title, description, tags, creator credit, source/permission statement, and explicit rights/upload consent. Consent is bound to an immutable SHA-256 image snapshot; cross-window changes reject submission rather than uploading a different background. The sender must be the app's trusted main frame. No provider keys, accounts, telemetry identifiers, paths, or background-effect settings are submitted.

Videos/GIFs are normalized by roxy.gg to silent H.264 MP4; source audio/metadata is removed before durable storage. Media is private until staff approval. Staff use roxy.gg/wallpapers/review. The backend and deployment setup are documented in the sibling `roxy.gg/docs/wallpapers.md`.

`ROXY_CATALOG_BASE` defaults to `https://roxy.gg`; only HTTPS or loopback HTTP origins are allowed. Preview images/videos use fixed first-party routes, anonymous CORS and no-referrer requests. Grid thumbnails are static, video preview is user-initiated/muted, reduced-motion uses posters, and hidden settings do not search or play previews.

Tests: `npm run smoke:wallpapers`, `npm run smoke:wallpapers-ui`, `npm run smoke:background`. Build roxy.gg first, then `npm run smoke:wallpapers-admin-ui` for the staff page's browser behavior. Dedicated UI smoke tests use port 3102 and mocked transports; backend tests exercise real migration/service SQL and authorization middleware separately. New locale keys have generated English fallback until translated.
