import PocketBase from 'pocketbase'

export class AjnaManager {
  constructor(pbUrl = 'http://localhost:8090') {
    this.pb = new PocketBase(pbUrl)
    this.objectMap = new Map()
    this.listeners = new Set()
  }

  onObjectsChanged(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitObjectsChanged() {
    const snapshot = Array.from(this.objectMap.values())
    this.listeners.forEach(listener => listener(snapshot))
  }

  async loadObjects() {
    const objects = await this.pb.collection('objects').getFullList()
    this.objectMap.clear()
    objects.forEach(obj => this.objectMap.set(obj.id, obj))
    this.emitObjectsChanged()

    // Realtime-Subscription beim ersten Load aufsetzen. Spätere
    // loadObjects-Aufrufe (z. B. nach Login/Logout) holen den vollen
    // Stand neu, die Subscription bleibt davon unberührt aktiv.
    await this._ensureRealtime()

    return objects
  }

  async _ensureRealtime() {
    if (this._realtimeReady) return
    this._realtimeReady = true

    this._realtimeUnsubscribe = await this.pb.collection('objects').subscribe('*', e => {
      // Eine einzige Realtime-Quelle: Server-Events landen in der zentralen
      // objectMap, dann läuft die normale Listener-Kette (EditorUI-Liste,
      // syncSceneObjects, Map-Marker). Damit reagieren Liste UND Szene
      // gleichermaßen auf Name-, Positions- und Parameter-Updates.
      if (e.action === 'create' || e.action === 'update') {
        this.objectMap.set(e.record.id, e.record)
      } else if (e.action === 'delete') {
        this.objectMap.delete(e.record.id)
      }
      this.emitObjectsChanged()
    })
  }

  async createObject(data) {
    const obj = await this.pb.collection('objects').create(data)
    this.objectMap.set(obj.id, obj)
    this.emitObjectsChanged()
    return obj
  }

  async updateObject(id, data) {
    const obj = await this.pb.collection('objects').update(id, data)
    this.objectMap.set(id, obj)
    this.emitObjectsChanged()
    return obj
  }

  async deleteObject(id) {
    await this.pb.collection('objects').delete(id)
    this.objectMap.delete(id)
    this.emitObjectsChanged()
  }

  async login(email, password) {
    const authData = await this.pb.collection('users').authWithPassword(email, password)
    return authData
  }

  logout() {
    this.pb.authStore.clear()
  }

  isLoggedIn() {
    return this.pb.authStore.isValid
  }

  getCurrentUser() {
    return this.pb.authStore.model || null
  }

  getObjectList() {
    return Array.from(this.objectMap.values())
  }

  getObjectById(id) {
    return this.objectMap.get(id)
  }

  canCreateObjects() {
    // In PocketBase: authStore.isValid indicates eingeloggter Nutzer.
    // Erweitern nach Bedarf (Role, ACL) im Backend bzw. Nutzer-Metadaten.
    return this.pb.authStore.isValid
  }
}
