import { BaseComponent } from "../BaseComponent.js"

export class GeospatialComponent extends BaseComponent {

  constructor(geo, lat, lon, altitude = 0, altitudeRef = 'ground') {
    super()
    this.geo = geo
    this.lat = lat
    this.lon = lon
    this.altitude = altitude
    // 'ground' = Höhe über Boden (AGL, Default), 'msl' = über Normalnull (AMSL).
    this.altitudeRef = altitudeRef
  }

  update() {
    const local = this.geo.toLocalRef(
      this.lat,
      this.lon,
      this.altitude,
      this.altitudeRef
    )

    this.gameObject.root.position.copyFrom(local)
  }

  setCoordinates(lat, lon, altitude = 0, altitudeRef = this.altitudeRef) {
    this.lat = lat
    this.lon = lon
    this.altitude = altitude
    this.altitudeRef = altitudeRef
  }
}