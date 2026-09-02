import Lean

/-! Fresh-process import verification for generated proof-tree modules. -/

open Lean

structure VerifyEntry where
  generated : String
  deriving FromJson

structure VerifyRequest where
  entries : Array VerifyEntry
  deriving FromJson

def readVerifyRequest (filename : String) : IO VerifyRequest := do
  let contents ← IO.FS.readFile filename
  let json ← match Json.parse contents with
    | .ok value => pure value
    | .error error => throw <| IO.userError s!"invalid request JSON: {error}"
  match fromJson? json with
  | .ok request => pure request
  | .error error => throw <| IO.userError s!"invalid proof-tree request: {error}"

unsafe def main (args : List String) : IO UInt32 := do
  let (requestPath, moduleName) ← match args with
    | [requestPath, moduleName] => pure (requestPath, moduleName)
    | _ =>
      IO.eprintln "usage: lean --run Verify.lean <request.json> <module>"
      return 1
  let request ← readVerifyRequest requestPath
  initSearchPath (← findSysroot)
  let env ← importModules #[{ module := moduleName.toName }] {}
    (trustLevel := 1024) (loadExts := false)
  for entry in request.entries do
    let name := entry.generated.toName
    let some info := env.find? name
      | throw <| IO.userError s!"generated theorem {name} is missing after a fresh import"
    match info with
    | .thmInfo _ => pure ()
    | _ => throw <| IO.userError s!"generated declaration {name} is not a theorem"
  IO.println s!"  verified {request.entries.size} generated theorems in a fresh process"
  return 0
