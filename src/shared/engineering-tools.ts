export const ENGINEERING_TOOLS = [
  { id: 'rea', name: 'REA', version: '6.7.0', url: 'https://github.com/morluto/rea' },
  {
    id: 'ghidra',
    name: 'Ghidra',
    version: '12.1.4',
    url: 'https://github.com/NationalSecurityAgency/ghidra'
  },
  {
    id: 'jadx',
    name: 'JADX',
    version: '0.7.1',
    url: 'https://github.com/1013503897/jadx-headless-mcp'
  },
  {
    id: 'adb',
    name: 'adb',
    version: '37.0.1',
    url: 'https://developer.android.com/tools/releases/platform-tools'
  },
  { id: 'frida', name: 'Frida', version: '17.23.2', url: 'https://frida.re' },
  { id: 'wireshark', name: 'Wireshark', version: '4.x', url: 'https://www.wireshark.org' }
] as const
export type EngineeringToolId = (typeof ENGINEERING_TOOLS)[number]['id']

// This is the supported, dependency-backed subset of the pinned REA release.
// Session/evidence tools belong to core and remain available to every active family.
export const ENGINEERING_SHARED_CALLS = [
  'close_binary',
  'binary_session',
  'inspect_analysis_view',
  'get_evidence_bundle',
  'export_evidence_bundle',
  'import_evidence_bundle',
  'list_unknowns',
  'record_unknown',
  'update_unknown',
  'verify_unknown_resolution',
  'verify_reconstruction'
] as const
export const ENGINEERING_TOOL_CALLS: Record<EngineeringToolId, readonly string[]> = {
  rea: [
    'open_binary',
    ...ENGINEERING_SHARED_CALLS,
    'inspect_artifact',
    'extract_artifact',
    'analyze_javascript_application',
    'trace_application_feature',
    'trace_javascript_semantics',
    'compare_source_to_bundle',
    'compare_application_versions',
    'inspect_managed_artifact',
    'inspect_managed_members',
    'inspect_managed_native_boundaries',
    'compare_managed_members',
    'inspect_go_binary',
    'inspect_rust_binary',
    'identify_flutter_build',
    'inspect_dart_aot',
    'compare_artifacts',
    'compare_functions',
    'compare_bundles',
    'build_call_path',
    'inspect_sqlite_database',
    'inspect_pe_resources',
    'inspect_web_network_capture'
  ],
  ghidra: [
    'open_binary',
    'analyze_function',
    'inspect_native_api',
    'procedure_pseudo_code',
    'procedure_assembly',
    'batch_decompile',
    'binary_overview',
    'address_name',
    'comment',
    'inline_comment',
    'list_names',
    'list_procedures',
    'list_segments',
    'list_strings',
    'list_bookmarks',
    'procedure_address',
    'procedure_callees',
    'procedure_callers',
    'procedure_info',
    'procedure_references',
    'read_function_instructions',
    'resolve_containing_procedure',
    'search_procedures',
    'search_strings',
    'xrefs',
    'get_call_graph',
    'trace_feature',
    'trace_call_path',
    'find_xrefs_to_name',
    'read_bytes',
    'search_bytes',
    'address_to_file_offset',
    'inspect_native_load_image',
    'inspect_native_data_type',
    'inspect_native_instruction',
    'resolve_native_call_targets',
    'inspect_native_dispatch_metadata',
    'trace_native_values',
    'inspect_address_context'
  ],
  jadx: [
    'inspect_android_package',
    'search_android_classes',
    'inspect_android_class',
    'inspect_android_method',
    'trace_android_references'
  ],
  adb: [
    'inspect_adb_client',
    'list_adb_devices',
    'inspect_adb_device',
    'list_adb_packages',
    'pull_adb_package',
    'read_adb_logcat',
    'inspect_adb_package',
    'pull_adb_file',
    'push_adb_file',
    'capture_adb_screen',
    'list_adb_processes',
    'list_adb_directory',
    'list_adb_features',
    'list_adb_services',
    'inspect_adb_display',
    'inspect_adb_window',
    'read_adb_setting',
    'collect_adb_bugreport',
    'resolve_adb_packages',
    'install_adb_package',
    'uninstall_adb_package',
    'start_adb_app',
    'start_adb_activity',
    'stop_adb_app'
  ],
  frida: [
    'list_frida_devices',
    'list_frida_processes',
    'start_frida_session',
    'load_frida_script',
    'resume_frida_session',
    'unload_frida_script',
    'frida_session_status',
    'close_frida_session',
    'instrument_with_frida'
  ],
  wireshark: [
    'inspect_pcap_client',
    'inspect_pcap_capture',
    'inspect_packet_fields',
    'inspect_packet_capture'
  ]
}
export const ENGINEERING_OPERATIONS = [...new Set(Object.values(ENGINEERING_TOOL_CALLS).flat())]
export const engineeringName = (operation: string): string => `rea_${operation}`

export interface EngineeringPreferences {
  enabled: boolean
  guidance: boolean
  groups: EngineeringToolId[]
  disabledCalls: string[]
}
export function engineeringPreferences(value: unknown): EngineeringPreferences {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    enabled: v.enabled === true,
    guidance: v.guidance === true,
    groups: ENGINEERING_TOOLS.filter(
      ({ id }) => Array.isArray(v.groups) && v.groups.includes(id)
    ).map(({ id }) => id),
    disabledCalls: ENGINEERING_OPERATIONS.filter(
      (name) => Array.isArray(v.disabledCalls) && v.disabledCalls.includes(name)
    )
  }
}
export function engineeringCallSupported(name: string, platform: string): boolean {
  if (platform !== 'linux' && ['inspect_packet_fields', 'inspect_packet_capture'].includes(name))
    return false
  if (platform === 'win32' && ['address_name', 'comment', 'inline_comment'].includes(name))
    return false
  return true
}
export function engineeringToolCalls(
  installed: readonly string[],
  platform: string,
  preferences: EngineeringPreferences
): string[] {
  if (!preferences.enabled || !installed.includes('rea')) return []
  const active = preferences.groups.filter((id) => installed.includes(id))
  if (!active.length) return []
  return [
    ...new Set([...ENGINEERING_SHARED_CALLS, ...active.flatMap((id) => ENGINEERING_TOOL_CALLS[id])])
  ].filter(
    (name) => !preferences.disabledCalls.includes(name) && engineeringCallSupported(name, platform)
  )
}
export type EngineeringError =
  | 'invalid'
  | 'busy'
  | 'unsupported'
  | 'download'
  | 'integrity'
  | 'install'
  | 'runtime'
  | 'cancelled'
  | 'manager'
  | 'permission'
export type EngineeringResult = { ok: true } | { ok: false; error: EngineeringError }
export interface EngineeringSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export interface EngineeringState {
  supported: boolean
  unsupported: EngineeringToolId[]
  platform: string
  installed: EngineeringToolId[]
  preferences: EngineeringPreferences
  batch: { current: number; total: number } | null
  job: {
    id: EngineeringToolId
    phase: 'downloading' | 'extracting' | 'installing' | 'checking'
    received: number
    total: number
  } | null
  error: { code: EngineeringError; detail?: string } | null
}
