import 'server-only';

// 글머리표 글리프가 빠진 글꼴 목록.
//
// CanvasKit 은 브라우저 시스템 폰트 폴백을 쓰지 않으므로, 문단에 적용된 글꼴의 웹폰트에
// □(U+25A1) 글리프가 없으면 글머리표가 화면에서 그냥 사라집니다. 글머리표 head 는 그 문단의
// 글꼴을 그대로 따라가므로(core 0.7.19 실측: 문단을 "바탕"으로 바꾸면 head run 의 fontFamily
// 도 "바탕"), format_* 로 글꼴만 바꿔도 기호가 안 보이게 될 수 있습니다.
//
// 아래 목록은 studio 번들의 (글꼴 이름 → woff2) 매핑과 각 woff2 의 cmap 을 실제로 조인해
// 뽑은 것입니다. studio 번들이나 public/studio/fonts 를 갱신하면 다시 생성하세요:
//
//   npm run fonts:coverage           # 전체 표 확인
//   npm run fonts:coverage -- --gaps # 아래 목록 형태로 출력
//
// 마지막 생성: @rhwp/editor 0.7.19 self-host 번들(public/studio, index-DzkU7Wfk.js) 기준.
const BULLET_UNSAFE_FONTS: readonly string[] = [
  '고운돋움',
  '고운바탕',
  '궁서',
  '궁서체',
  '나눔고딕',
  '나눔고딕코딩',
  '나눔명조',
  '바탕',
  '새궁서',
  '양재튼튼체B',
  'Cafe24 Ssurround Bold',
  'HY견고딕',
  'HY견명조',
  'HY신명조',
  'HY헤드라인M',
  'HYGothic-Extra',
  'HYHeadLine M',
  'HYHeadLine Medium',
  'HYMyeongJo-Extra',
  'Noto Serif KR',
  'Palatino Linotype',
  'Source Han Serif K Old Hangul',
];

// 함초롬/한컴 계열(함초롬바탕·함초롬돋움·한컴바탕·한컴돋움·새바탕·새돋움)은 studio 가 CDN 웹폰트
// (HANBatang.woff/HCRDotum.woff)로 받아쓰므로 스크립트가 오프라인에서 검사하지 못합니다.
// 두 폰트 모두 □·○·◦·■·● 등 도형 글리프를 갖고 있는 것을 직접 내려받아 확인했으니 안전 목록에 둡니다.
/** 글머리표 기호가 정상 렌더되는, 흔히 쓰는 대안 글꼴. */
export const BULLET_SAFE_FONTS: readonly string[] = ['함초롬바탕', '함초롬돋움', '맑은 고딕', '돋움', 'HY중고딕'];

// 이름 비교용 정규화: 공백 제거 + 소문자. "맑은 고딕"/"맑은고딕", 대소문자 차이를 흡수합니다.
function normalize(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

const UNSAFE_SET = new Set(BULLET_UNSAFE_FONTS.map(normalize));

/** 그 글꼴로 바꾸면 글머리표(□·○ 등)가 화면에서 사라지는지. */
export function isBulletUnsafeFont(fontName: string): boolean {
  return UNSAFE_SET.has(normalize(fontName));
}

// 이 범위의 문자를 글머리표로 쓰면 위 글꼴에서 렌더되지 않습니다.
// U+25A0–25FF(도형), U+2190–21FF(화살표), U+2600–26FF(기타 기호).
export function isShapeBulletChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 0x25a0 && code <= 0x25ff) || (code >= 0x2190 && code <= 0x21ff) || (code >= 0x2600 && code <= 0x26ff);
}
