!macro customInstall
  FileOpen $0 "$INSTDIR\resources\installed-by-nsis" w
  FileWrite $0 "installed"
  FileClose $0
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.akina910.obs-stream-manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OBS Stream Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "obs-stream-manager"
!macroend
