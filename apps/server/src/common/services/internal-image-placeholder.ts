/**
 * Served in place of an internal-network image when the request comes from the
 * office network (design §12). The image URL is the same for both zones, so the
 * response must never be cached: an internal user opening the same page later
 * has to get the real image.
 */
export const INTERNAL_IMAGE_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270" role="img" aria-label="內網圖片,無法在外網顯示">
<rect x="1" y="1" width="478" height="268" rx="12" fill="#f4f5f7" stroke="#c4c9d2" stroke-width="2" stroke-dasharray="8 6"/>
<g transform="translate(240 104)" fill="none" stroke="#6b7280" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
<rect x="-30" y="-6" width="60" height="46" rx="6" fill="#e5e7eb"/>
<path d="M-18 -6v-12a18 18 0 0 1 36 0v12"/>
<circle cx="0" cy="17" r="4" fill="#6b7280" stroke="none"/>
</g>
<text x="240" y="196" text-anchor="middle" font-family="-apple-system, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', sans-serif" font-size="24" font-weight="600" fill="#374151">內網圖片</text>
<text x="240" y="230" text-anchor="middle" font-family="-apple-system, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', sans-serif" font-size="17" fill="#6b7280">無法在外網顯示</text>
</svg>
`;
