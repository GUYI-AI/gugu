# App picture feedback (API 58)

Needs `agents:tools`
- On your existing projection resource, `resource.present(value | null)` publishes only display data.
  First publish pixels with `target: {id, revision}`: your stable opaque target identity and increasing revision.
  Then present `{frame:{sequence,width,height,target},targetLabel?,cursor?:{x,y,click?},action?:{id,label,phase}}`.
  The sequence/size/target must match your latest publication receipt. Cursor coordinates use its input space;
  click is a unique gesture ID. Labels are plain text, at most 200 characters; IDs are bounded strings.
  Supply targetLabel only when your existing App presentation has that target component; it is not an extra App/location row.
  Phase is running/done/failed/paused from your admitted operation, never video readiness or a retained source.
  Main stamps source, viewer generation and presentation revision. Only an actually painted matching frame displays it.
  `resource.present(null)` invalidates the old decoration before changing/losing a target; it cannot revive until
  a new picture is published. Disconnect and decoding invalidation clear the viewer's display. No input is authorized.
- Apps using this method declare API58. Earlier Apps retain their original pixel feed. Viewers opt in before any
  new packet type is sent. An older host/viewer keeps pixels and displays no guessed target, cursor or operating state.
  Shared host pictures opt in to passive decorations; an App page can retain its own existing surrounding UI.
  Pictures never use App-wide program notifications; remote metadata follows the existing authorized picture/media channel.
