!macro customInstall
  ; Migrate the incorrect per-user plugin location used by 0.1.x/early 0.2.0 builds.
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  FileOpen $0 "$INSTDIR\resources\installed-by-nsis" w
  FileWrite $0 "installed"
  FileClose $0
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.akina910.obs-stream-manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OBS Stream Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "obs-stream-manager"
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  ReadEnvStr $1 "ProgramData"
  StrCmp $1 "" +2
  RMDir /r "$1\obs-studio\plugins\obs-stream-manager-output"
!macroend
