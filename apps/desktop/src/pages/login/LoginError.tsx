import { loginErrorParts } from './loginErrorLinks'

export function LoginError({ message }: { message: string }) {
  return <p role="alert" className="gugu-auth-error">{loginErrorParts(message).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" onClick={event => {
      event.preventDefault()
      // The existing local window-open handler opens the person's system browser.
      window.open(part.href, '_blank', 'noopener,noreferrer')
    }}>{part.text}</a>
    : part.text)}</p>
}
