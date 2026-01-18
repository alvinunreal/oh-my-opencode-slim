export interface NpmDistTags {
  latest: string
  [key: string]: string
}

export interface OpencodeConfig {
  plugin?: string[]
  [key: string]: unknown
}

export interface PackageJson {
  version: string
  name?: string
  [key: string]: unknown
}

export interface AutoUpdateCheckerOptions {
  showStartupToast?: boolean
  autoUpdate?: boolean
}
