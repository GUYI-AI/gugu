import {useTranslation} from 'react-i18next'
import {useDevicesStore} from '../../store/devicesContext'
import {useCloudComputerWake} from '../../hooks/useWakeCloudComputer'
import type {ConnectionState} from '../connection/connectionState'

/**
 * The live link to the computer running an assistant task, as the header's connection state (owner 11-08: 「连接中」 /
 * 「设备离线」 in the header, ❌ a notice line under it). No device yet = nothing to say (`online`).
 */
export function useAssistantWorkRuntime(deviceId:string|null):{ready:boolean;connection:ConnectionState;lastSeenAt:string|null;detail:string|null}{
 const {devices,phones=[]}=useDevicesStore()
 const device=[...devices,...phones].find(row=>row.device_id===deviceId)??null
 const {issue,dropped}=useCloudComputerWake(device)
 const {t:common}=useTranslation('common')
 const waking=device?.cloud_computer==='asleep'||device?.cloud_computer==='waking'
 const ready=!!device&&!waking&&(device.is_online||device.is_current_device===true)
 const connection:ConnectionState=!deviceId||ready?'online'
  :issue?'device_offline'
  :waking||dropped||!device?'connecting'
  :'device_offline'
 return {ready,connection,lastSeenAt:device?.last_seen_at??null,detail:issue?common(`cloudComputer.reason.${issue.kind}`):null}
}
