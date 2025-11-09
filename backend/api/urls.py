from django.urls import path
from . import views
from rest_framework import routers
from .views import StartingCapitalViewSet, MaterialViewSet, CustomerViewSet, ExpenseViewSet, TransactionViewSet

# Initialize the DRF Router
router = routers.DefaultRouter()

# Register ViewSets with their respective path prefixes
router.register(r'startingcapital', StartingCapitalViewSet)
router.register(r'materials', MaterialViewSet)
router.register(r'customers', CustomerViewSet)
router.register(r'transactions', TransactionViewSet)
router.register(r'expenses', ExpenseViewSet)

# The list of URLs for the application
urlpatterns = router.urls
