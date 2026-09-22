import * as THREE from 'three'
import Stats from 'three/addons/libs/stats.module.js';

/**
 * Internal datas
 */

// Window sizes
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

// background color
const backgroundColor = 0x000000;

let canvas, scene, camera, renderer, 
    stats, timer;

/**
 * Init the three.js engine and return the scene, camera and renderer
 * camera z = 3, anti-aliasing enabled, responsive to window resize
 * @property {boolean} prod - If true, stats will not be displayed
 * @returns {object} - {scene, camera, renderer}
 */
export const init = (prod=false)=>{

  // Canvas
  canvas = document.querySelector('canvas.webgl');

  // Scene
  scene = new THREE.Scene();

  /**
   * Camera
   */
  camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height);
  camera.position.z = 3;
  scene.add(camera);

  /**
   * Renderer
   */
  renderer = new THREE.WebGLRenderer({
    antialias: true
  })
  renderer.setPixelRatio( window.devicePixelRatio );
  renderer.setSize( sizes.width, sizes.height );
  renderer.setClearColor( backgroundColor, 1 );

  document.body.appendChild(renderer.domElement);

  prepare_responsive();

  if(prod === false){
    // Stats
    stats = new Stats();
    document.body.appendChild( stats.dom );
  }

  return {scene: scene, camera: camera, renderer: renderer};
}

/**
 * Start the animation loop, calling the animate function with the delta time
 * @property {function} animate - The function to call each frame with the delta time
 */
export const run = (animate)=>{

  // Timer
  timer = new THREE.Timer();
  timer.connect( document );

  // Animation loop
  renderer.setAnimationLoop( ()=>{

    timer.update();
    const delta = timer.getDelta();

    animate(delta);

    stats.update();
    renderer.render( scene, camera );
  } );
} 

/**
 * PRIVATE FUNCTIONS
 */

/**
 * Make the renderer and camera responsive to window resize
 */
const prepare_responsive = ()=>{

  window.addEventListener('resize', () =>
  {
      // Update sizes
      sizes.width = window.innerWidth;
      sizes.height = window.innerHeight;

      // Update camera
      camera.aspect = sizes.width / sizes.height;
      camera.updateProjectionMatrix();

      // Update renderer
      renderer.setSize(sizes.width, sizes.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });
}
