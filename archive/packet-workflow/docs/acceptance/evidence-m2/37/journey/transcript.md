# Packet 37 integrated journey (deployed artifacts)

- repo: /home/dadmin/projects/thirdlight
- disposable root: /tmp/tl37-journey-Nf4j3V
- backend bundle sha256: b3cf2f5a17bb684f33b250ff9ac8ae40b66d1c5e3747d1dcfd1dfa0f0cfc808c
- mcp bundle sha256: 53f305504ad6bd0ade5ff63a63b6da82c3c8ddc216aa9e805414af38a5f21d7d

## A01 migration-copy (A09 durability)
[PASS] A01.migration — ok=true resumed=false sourceRevision=3 newRevision=0 policy=reset-to-zero sourceBytesIdentical=true destEqualsAcceptedFixture=true
backend ready (pid 3152432)
[PASS] A01.m1-v1 — create=201 v1CommandOk=true boxError= malformedStatus=503 malformedCode=project_unavailable fileUnchanged=true

## A02/A03/A04 content import, reimport, malformed rejection
[PASS] A02.import+place — assetId=asset-00000000000037a1 v1Digest=5d9f74122d1269c8… placements=model-0001,model-0002 distinct=true
[PASS] A04.reject — bad=true external=true required-ext=true limit=true envelopeUnchanged=true revisionUnchanged=true
[PASS] A03.reimport — reimport=200 idsTransformsStable=true version v2=2 undo=1 redo=2

## A05/A06/A07 prefab, declared properties, MCP parity
[PASS] A05.prefab — capture=200 instantiate=200 mapping=group-0001->group-0002,box-0001->box-0002 overrideOk=true copiesIndependent=true
[PASS] A06.prefab-reject — cameraCapture=prefab_camera_capture_forbidden unknownOverride=property_unknown atomicallyUnchanged=true
[PASS] A07.mcp-property — tools=11 editSpeed=1.5 stale=revision_conflict mutationAppliesConverged=true

## A15/A16 behavior build, trust, execution, negatives
[PASS] A15/A16.behavior — sourceDigest=2dc14760fe1d4c2c… outputDigest=55ff57e06358123d… sourceRecorded=true hostile=400/behavior_import_forbidden oldPublicationRetained=true trustNoticeTextPresent=true

## A17/A18/A19/A20 play delivery, pinning, MCP relay, security, lifecycle
[PASS] A17.play-pinning — manifestFrozenDuringPlay=true assetDigestOk=true playBuild=e4767983f400… freshBuild=89a86a1ce515… freshAdoptsNewRevision=true
[PASS] A18.delivery-security — traversal=400 undeclared=400 foreignContent=404 listing=400 capabilityRedacted=true
[PASS] A19.mcp-relay — relay={"ok":true,"mode":"exclusive-test","playSessionId":"play-5d4385aa6891cd69a654321e50ab999e","snapshotId":"demo-m1-v2@r24","buildId":"e4767983f400ec9b90a28293b7b0e574f82956615f7533befc409ccc76f01c0b","appliedFromStep":100,"appliedToStep":102,"inputMode":"test","clearedAt":"2026-09-19T12:59:47.578Z"} unknownPlayIsError=true unknownPlayCode=play_not_found
[PASS] A20.lifecycle — repeated start/stop cycles=5 stopStatuses=200/200/200/200/200/200 stopResponsesOk=true ownerStoppedEvents=6 stopUnconfirmed=0 allStopsConfirmedRequestReason=true

## A09 crash, takeover, retry, expired stage replay
backend SIGKILLed (pid 3152432)
[PASS] A09.crash — preCrashAckedRevision=26 (from 25) preCrashEntity=box-0004 staleOwnershipAfterRestart=stale_ownership takeoverStatus=200 postRecoveryCommand=200 retryDuplicated=true durableEntityPresent=true orphanStage=stg-b4ed9755a5e231a9a367853b9b7e4899

## A10 tamper, missing source, derived cache, source backup/restore
[PASS] A10.durability — derivedExisted=true cacheDeletionRecoverable=true tamperDetected=true missingDetected=true restoredByteExact=true freshPlayAfterRestore=200

## A21/A22/A23 export, reproducibility, failure isolation, static serving
[PASS] A21/A23.export — export1=200 export2=200 exportRootsDistinct=true sameFileSet=true differing=manifest.json,meta.json failureIsolated=true backendsStoppedStaticServe=true mime=true externalRequests=0 files=7
[PASS] A22.reproducibility — exportRoot1=/tmp/tl37-journey-Nf4j3V/exports exportRoot2=/tmp/tl37-journey-Nf4j3V/exports-2 fileSetsEqual=true files=7 differing=manifest.json,meta.json timestampCarriersOnly=true nonTimestampBytesIdentical=true buildIdEqual=false capturedAt1=2026-09-19T12:59:48Z capturedAt2=2026-09-19T12:59:50Z rederivedBuildIdMatchesFirst=true

## A24 clean-install, boundaries, pins
[PASS] A24.pins — {"three":"0.186.0","esbuild":"0.28.2","typescript":"5.9.3","vitest":"5.0.1","ws":"8.21.3","rapier":"0.20.0","mcp":"1.30.0"}

## summary
- results: {"PASS":18}