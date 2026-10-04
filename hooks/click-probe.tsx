import type { ClientModule } from 'claude-code'

type Props = { zone: string }

// A transparent probe laid over one area: a click tells the hooks module, which toggles that area's expanded state
const probe: ClientModule<Props, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(ev => {
      if (ev.type === 'up') surface.post({ zone: props.zone })
    })
    surface.setState(true)
  }

  const { Box } = surface.elements

  return <Box width="100%" height="100%" />
}

export default probe
