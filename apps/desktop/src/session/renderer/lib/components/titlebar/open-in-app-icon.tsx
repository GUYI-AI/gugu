/** 「用…打开」那一排的应用图标。单色的(svg 填 currentColor)用遮罩画、底色取 currentColor:<img> 里的 currentColor 不认外面的文字色。 */
export function OpenInAppIcon({ src, monochrome, alt }: { src: string | undefined; monochrome?: boolean; alt: string }) {
  if (!src) return null;
  if (!monochrome) return <img src={src} alt={alt} className="size-4 rounded-sm" />;
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className="inline-block size-4 shrink-0 bg-current"
      style={{ maskImage: `url(${src})`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' }}
    />
  );
}
