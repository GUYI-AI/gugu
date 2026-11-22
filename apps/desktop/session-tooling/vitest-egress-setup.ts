// Host code under test reaches the network through the egress (a host process without one throws). In tests the egress is
// the runtime's own fetch and WebSocket, so a test can stub the globals; proxy routes come from the test's environment.
import { installEgress, installEnvironmentFetch, runtimeEgress } from '@gugu/core/shared/egress'
import { createEnvironmentFetch } from '../electron/egress/environment'
import { envRoutes, installProxyRoutes } from '../electron/egress/proxy-route'

installEgress(runtimeEgress())
installEnvironmentFetch(createEnvironmentFetch())
installProxyRoutes(envRoutes())
