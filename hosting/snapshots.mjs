export function snapshotFile(election) {
  if (typeof election !== 'string' || !/^K[1-9][0-9]*$/.test(election)) throw new Error('Invalid election')
  return election.toLowerCase() + '-results.json'
}

export function createSnapshotLoader(fetchFile = fetch) {
  const cache = new Map()
  return (election) => {
    const file = snapshotFile(election)
    let entry = cache.get(election)
    if (entry) {
      cache.delete(election)
    } else {
      const controller = new AbortController()
      entry = {
        controller,
        promise: fetchFile('./' + file, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error('Could not load election results')
          const snapshot = await response.json()
          if (snapshot.election !== election || !Array.isArray(snapshot.parties) || !Array.isArray(snapshot.units)) {
            throw new Error('Unexpected election results')
          }
          return snapshot
        }).catch((error) => {
          if (cache.get(election) === entry) cache.delete(election)
          throw error
        }),
      }
    }
    cache.set(election, entry)
    // Retain only recent elections; a snapshot contains national geometry.
    if (cache.size > 2) {
      const oldest = cache.keys().next().value
      cache.get(oldest).controller.abort()
      cache.delete(oldest)
    }
    return entry.promise
  }
}
