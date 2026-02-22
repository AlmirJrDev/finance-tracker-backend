const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/categoryController')
const { authenticate } = require('../middleware/auth')

router.use(authenticate)

router.get('/', ctrl.list)
router.post('/', ctrl.create)
router.put('/:id', ctrl.update)
router.delete('/:id', ctrl.remove)
router.get('/stats/:year/:month', ctrl.getStats)

module.exports = router