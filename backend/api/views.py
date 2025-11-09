from rest_framework import viewsets
from .models import StartingCapital, Material, Customer, Expense, Transaction
from .serializers import StartingCapitalSerializer, MaterialSerializer, CustomerSerializer, ExpenseSerializer, TransactionSerializer, UserSerializer, LoginSerializer
from django.contrib.auth.models import User
from rest_framework import generics
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework.permissions import IsAuthenticated, AllowAny
from django.contrib.auth import authenticate
# Create your views here.

class CreateUserView(generics.CreateAPIView):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    permission_classes = [AllowAny]

class LoginView(generics.GenericAPIView):
	serializer_class = LoginSerializer
    
	def post(self, request, *args, **kwargs):
		username = request.data.get("username")
		password = request.data.get("password")
		user = authenticate(usernane = username, password = password)
		if user is not None:
			refresh = RefreshToken.for_user(user)
			user_serializer = UserSerializer(user)
			return Response({
				'refresh': str(refresh),
				'access':str(refresh.access_token),
				'user': user_serializer.data
			})
		else:
			return Response({'detail': 'Invalid credentials'}, status=401)


class StartingCapitalViewSet(viewsets.ModelViewSet):
    """API endpoint for Materials."""
    queryset = StartingCapital.objects.all()
    serializer_class = StartingCapitalSerializer


class MaterialViewSet(viewsets.ModelViewSet):
    """API endpoint for Materials."""
    queryset = Material.objects.all().order_by('name')
    serializer_class = MaterialSerializer

class CustomerViewSet(viewsets.ModelViewSet):
    """API endpoint for Customers."""
    queryset = Customer.objects.all().order_by('name')
    serializer_class = CustomerSerializer


class ExpenseViewSet(viewsets.ModelViewSet):
    """API endpoint for Expenses."""
    queryset = Expense.objects.all().order_by('-date')
    serializer_class = ExpenseSerializer


class TransactionViewSet(viewsets.ModelViewSet):
    """API endpoint for Transactions (CR, DB, RC)."""
    queryset = Transaction.objects.all().order_by('-timestamp')
    serializer_class = TransactionSerializer
