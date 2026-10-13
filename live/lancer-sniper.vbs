' Lance le sniper à la seconde sans fenêtre (utilisé par la tâche planifiée Windows "Sniper crypto")
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dossier
sh.Run "node live\sniper-rt.js", 0, False
sh.Run "node live\sniper-loop.js", 0, False
