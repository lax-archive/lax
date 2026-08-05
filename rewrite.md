# intro

we are in the middle of rewriting this repo onto github actions architecture. this was done by a dilligent ai model, but with very little supervision, so it might have gotten off the track implementing things that we dont want. 

old lax: this folder
new rewrite: ../laxnew

my first gut-based impression: their code has much more loc while ours is more compact with better tests, so there is some fluff/redundancy/overengineering in the codebase. watch out for that.

we are not implementing anything yet, just planning. the other repo was written by an outside ai model, and their way of building things might not mirror our most productive setup. we will carefully prepare our best setup before we write any code, potentially rewriting things to better fit our workflow and way of thinking.

i will outline some changes i want to apply to the new rewrite.

# build pipeline

the new build pipeline got too complicated, we therefore simplify the design to be more similar to the old pipeline.
in particular, the olean caching mechnism and the job orchestration can be simpler.

- start a runner with read-only authentication. cannot write to the db or
  website.
- install 
    - our code
    - elan lake lean
    - mathlib and get oleans via exe cache get
- clone the submitted repository
- static validation (checks only lakefiles, manifests and so on)
- resolution (check the dependencies)
- provide cache (for each dependency, read the key (repo, folder, commit,
  proof|concept) from ghcr)
- run the untrusted user code in a sandbox
    - bwrap is not installed by default on the runner and can be a bit flaky to setup
    - i dont want to spread the review surface out to dockerfiles and dockercomposes.
    - therefore my suggestion: run user code via docker with a simple plain
      image with readmount of lake and lean and node. no second dockerfile
      review surface needed.
- run the remaining inspection and replay outside docker, on the vm again.
- hand out the artifacts: build-output.json, source code, and oleans

- start a second runner with write rights and consume the firsts's artifacts.
- to integrate the data into our system
    - update database with new submission
    - append cache (write to ghcr with key (repo, folder, commit,
      proof|concept))
    - trigger website build

i am open to use bwrap instead of docker, but only if there is enough evidence it is better suited.

if you prefer dockerfiles, you should make your case.

additional considerations:

## profiling

later, when rewriting, we 
add proper profiling to the build. i want to know how much time is spent in
    - setting up the vm (installation and download of lake lean mathlib dockerimage, ...)
    - validation/resolution
    - build
    - verify
    - inspect


## parallelism in submission handling

we also first need a clean plan how concurrent submission handle database writing. simplest idea: make the second write runner atomic? better ideas?


## sibling paths

big change: we fully forbid this! this should make life significantly simpler! instead we can use the following workflow: if A -> B -> C, we comit C, patch in the hash into B, commit B, patch in the hash into A, commit A. we can then handle multi-submisison submits via a simple cli-only change: let lax submit A B C can just be a macro for lax submit A; lax submit B; lax submit C or similar. i want this workflow to be discoverable, so at those places where things break, the cli should suggest the workflow to the user.
locally, we can sidestep this dance via package-overrides (discussed below)

dont spend too much time thinking about this yet. only becomes relevant when we actually plan the write.


## multiple statements per concept

goal for the new lax: now we want to go back to allowing multiple statements per concept. the main reason why i wanted 1 only, was the website, but i think i figured out how to have multiple on the website.

Besides adapting the new lax, the following website work is necessary:

I now have a preferred option how to allow multiple statements per concept while still rendering nicely on the website: refer to the statements within a conclusion only via anonymous indices on the webiste. so on the proof network, each concept with multiple statements has little blue nodes numbered 1,2,3,etc below them, with incoming edges. on the list of proofs above, we would write in the conclusion "Menger (xth axiom)" or similar to indicate which one it proves. both in the proof network and the proof list, we do not mention for the assumptions which statemet of a claim was used. 
in the datastructures and backend, statements behave as usual, they are not anonymous or anything, this is website presentation only.

dont spend too much time thinking about this yet. only becomes relevant when we actually plan the write.

## local build

it seems in laxnew, local build uses docker and skips altogether if no docker is there. we dont want that. we want the oldlax behaviour: no containers, but always build. so in particular we want that lax build uses the same warm environemnt that normal lean builds already prepared when working on the submission.

# tests

we created many tests, in particular also E2E tests. i think they feature many pain points we had during development and are worth porting. we want to port this over. the website stuff can of course go to the extracted website repo, but the main body should be ported. are there any rewrite decisions that make porting difficult? (e.g. no injection of fake things via env vars?)


# local cli

a lot of field-work shaped the various cli flags and commands. we want to preserve these.
i heard most got properly ported

--resume should be ported, too.


# institutional knowledge

we probably want to port over our spec.md spec_notes.md files and infrastructure! but laxnew might have its own instruction files. how do we consolidate?



# no whitelist of users

we are fully open now in the rewrite. we know that we dont have the secure concept dialect in place, so we inform the users that cloning other peoples code is at their own risk. DO NOT DISCUSS THE WHITELIST DROP OR SECURITY IMPLICATIONS WITH ME. we are on top of it and have ideas how to make it safe enough.


# anything else?

we did a lot of stuff in this repo by fixing pain points that appeared throught development. i would be surprised if the rewrite catches these things first try. so keep an eye open for all kinds of improvements to the rewrite!

# other todos (ordered decreasingly by importance)

we can drop this horrible hardlink game to share mathlib. the following is much cleaner!
we populate it gitignored during init.
during build, we require that its not checked in, as otherwise it might corrupt builds.
this is from now on also our recommended workflow for working on two draft submissions in parallel
https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/#package-overrides

no lax command should mysteriously wait for a long time without giving any indication. in particular, they all should immediatley print at least one message.
mathlib hardlink generation should also emit a message.

we could make lax doctor progressive: show info as it arrives.

