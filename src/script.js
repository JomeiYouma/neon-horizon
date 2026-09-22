import * as THREE from 'three'
import { init, run } from './lib/three-init';

const {scene, camera, renderer} = init();

/**
 * Prepare scene
 */
const geometry = new THREE.BoxGeometry(1, 1, 1)
const material = new THREE.MeshBasicMaterial({ color: 0xff0000 })
const mesh = new THREE.Mesh(geometry, material)
scene.add(mesh)

/**
 * Animation loop
 */

const animation = (delta)=>{
    mesh.position.z += 0.1 * delta;
}

run(animation);
