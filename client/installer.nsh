!include "LogicLib.nsh"

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\convoygate.dll"
    ; Standard Steam (C: Drive)
    ${If} ${FileExists} "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate.dll" "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    ${EndIf}

    ${If} ${FileExists} "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate.dll" "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    ${EndIf}

    ; Secondary Steam Drives (D: & E:)
    ${If} ${FileExists} "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate.dll" "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    ${EndIf}

    ${If} ${FileExists} "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate.dll" "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  RMDir /r "$DOCUMENTS\American Truck Simulator\mod"
  RMDir /r "$DOCUMENTS\Euro Truck Simulator 2\mod"

  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

  RMDir /r "$APPDATA\convoygate-client"
  RMDir /r "$APPDATA\convoygate"
!macroend